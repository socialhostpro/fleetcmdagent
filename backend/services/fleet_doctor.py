"""
Fleet Doctor - Autonomous AI Self-Healing System

Continuously monitors the fleet, detects problems, diagnoses issues using DeepSeek LLM,
executes repairs automatically, and reports results.
"""

import os
import json
import asyncio
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List
import redis.asyncio as redis
import httpx

from .doctor_problems import Problem, detect_all_problems, Severity
from .doctor_actions import ActionExecutor, ActionResult, PROBLEM_ACTION_MAP


class FleetDoctor:
    """
    Autonomous AI agent that monitors and heals the fleet.

    Features:
    - Continuous monitoring every 30 seconds
    - Problem detection for disk, memory, Docker, Swarm issues
    - AI-powered diagnosis using DeepSeek LLM
    - Automatic remediation for low/medium risk issues
    - Human escalation for high risk issues
    - Full action history and reporting
    """

    def __init__(
        self,
        redis_url: str = "redis://comfyui-redis:6379",
        ollama_url: str = "http://jessica-ollama-gb10:11434",
        api_url: str = "http://localhost:8765",
        model: str = "deepseek-coder:6.7b"
    ):
        self.redis_url = redis_url
        self.ollama_url = ollama_url
        self.api_url = api_url
        self.model = model

        self.redis_client: Optional[redis.Redis] = None
        self.action_executor: Optional[ActionExecutor] = None
        self.http_client: Optional[httpx.AsyncClient] = None

        self.running = False
        self.task: Optional[asyncio.Task] = None

        # Configuration
        self.config = {
            "interval": int(os.getenv("FLEET_DOCTOR_INTERVAL", "30")),
            "auto_fix": os.getenv("FLEET_DOCTOR_AUTO_FIX", "true").lower() == "true",
            "disk_threshold": int(os.getenv("FLEET_DOCTOR_DISK_THRESHOLD", "85")),
            "disk_critical_threshold": 95,
            "memory_threshold": int(os.getenv("FLEET_DOCTOR_MEMORY_THRESHOLD", "90")),
            "auto_fix_levels": os.getenv("FLEET_DOCTOR_AUTO_FIX_LEVELS", "low,medium").split(","),
            "alert_levels": os.getenv("FLEET_DOCTOR_ALERT_LEVELS", "high,critical").split(","),
            "cooldown_minutes": 5,
            "max_actions_per_hour": 20,
            "job_failure_threshold": 3
        }

        # State tracking
        self.last_check = None
        self.problems_found = []
        self.action_cooldowns: Dict[str, datetime] = {}  # node_id -> last_action_time
        self.actions_this_hour = 0
        self.hour_start = datetime.utcnow()

    async def connect(self):
        """Initialize connections."""
        self.redis_client = redis.from_url(self.redis_url, decode_responses=True)
        await self.redis_client.ping()
        print(f"Fleet Doctor connected to Redis: {self.redis_url}")

        self.action_executor = ActionExecutor(self.api_url)
        self.http_client = httpx.AsyncClient(timeout=120.0)

        # Load saved config from Redis if exists
        saved_config = await self.redis_client.get("fleet:doctor:config")
        if saved_config:
            self.config.update(json.loads(saved_config))

        print(f"Fleet Doctor initialized with model: {self.model}")

    async def disconnect(self):
        """Clean up connections."""
        if self.redis_client:
            await self.redis_client.close()
        if self.action_executor:
            await self.action_executor.close()
        if self.http_client:
            await self.http_client.aclose()

    def stop(self):
        """Stop the doctor loop."""
        self.running = False
        if self.task:
            self.task.cancel()

    async def run(self):
        """Main monitoring loop."""
        self.running = True
        print(f"Fleet Doctor starting - checking every {self.config['interval']}s")

        await self._update_status("running")

        while self.running:
            try:
                await self._check_cycle()
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"Fleet Doctor error: {e}")
                await self._publish_event("error", {"error": str(e)})

            await asyncio.sleep(self.config["interval"])

        await self._update_status("stopped")
        print("Fleet Doctor stopped")

    async def run_once(self):
        """Run a single check cycle (for manual trigger)."""
        await self._check_cycle()

    async def _check_cycle(self):
        """Single monitoring cycle."""
        self.last_check = datetime.utcnow()
        await self._update_status("checking")

        # Reset hourly counter if needed
        if datetime.utcnow() - self.hour_start > timedelta(hours=1):
            self.actions_this_hour = 0
            self.hour_start = datetime.utcnow()

        # 1. Detect problems
        problems = await detect_all_problems(self.redis_client, self.config)
        self.problems_found = problems

        # Store current problems
        await self._store_problems(problems)

        if not problems:
            await self._update_status("healthy")
            return

        print(f"Fleet Doctor found {len(problems)} problems")
        await self._update_status("diagnosing", {"problem_count": len(problems)})

        # 2. Process each problem
        for problem in problems:
            await self._publish_event("problem_detected", problem.to_dict())

            # Check if we can auto-fix
            if not self.config["auto_fix"]:
                await self._publish_event("alert", {
                    "problem": problem.to_dict(),
                    "message": "Auto-fix disabled - manual intervention required"
                })
                continue

            # Check cooldown
            if problem.node_id and problem.node_id in self.action_cooldowns:
                last_action = self.action_cooldowns[problem.node_id]
                if datetime.utcnow() - last_action < timedelta(minutes=self.config["cooldown_minutes"]):
                    print(f"Skipping {problem.node_id} - in cooldown")
                    continue

            # Check rate limit
            if self.actions_this_hour >= self.config["max_actions_per_hour"]:
                print("Rate limit reached - skipping actions")
                await self._publish_event("rate_limited", {"limit": self.config["max_actions_per_hour"]})
                continue

            # 3. Get AI diagnosis
            diagnosis = await self._diagnose(problem)

            if not diagnosis:
                continue

            await self._publish_event("diagnosis_complete", {
                "problem": problem.to_dict(),
                "diagnosis": diagnosis
            })

            # 4. Execute action if appropriate
            if diagnosis.get("can_auto_fix") and diagnosis.get("risk_level") in self.config["auto_fix_levels"]:
                for action_spec in diagnosis.get("recommended_actions", []):
                    result = await self._execute_action(problem, action_spec)
                    await self._log_action(problem, diagnosis, result)

                    if result.success:
                        await self._publish_event("action_completed", result.to_dict())
                    else:
                        await self._publish_event("action_failed", result.to_dict())
            else:
                # Escalate to human
                await self._publish_event("escalation", {
                    "problem": problem.to_dict(),
                    "diagnosis": diagnosis,
                    "reason": f"Risk level {diagnosis.get('risk_level')} requires human approval"
                })

        await self._update_status("running")

    async def _diagnose(self, problem: Problem) -> Optional[Dict[str, Any]]:
        """Use DeepSeek to diagnose the problem and recommend actions."""
        # Get fleet context
        fleet_context = await self._get_fleet_context()

        # Get node details if applicable
        node_details = None
        if problem.node_id:
            node_details = await self._get_node_details(problem.node_id)

        # Build prompt
        prompt = self._build_diagnosis_prompt(problem, fleet_context, node_details)

        try:
            response = await self.http_client.post(
                f"{self.ollama_url}/api/generate",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json"
                }
            )

            if response.status_code != 200:
                print(f"Ollama error: {response.status_code}")
                return self._default_diagnosis(problem)

            result = response.json()
            response_text = result.get("response", "")

            try:
                diagnosis = json.loads(response_text)
                return diagnosis
            except json.JSONDecodeError:
                print(f"Failed to parse AI response: {response_text[:200]}")
                return self._default_diagnosis(problem)

        except Exception as e:
            print(f"Diagnosis error: {e}")
            return self._default_diagnosis(problem)

    def _build_diagnosis_prompt(
        self,
        problem: Problem,
        fleet_context: dict,
        node_details: Optional[dict]
    ) -> str:
        """Build the prompt for AI diagnosis."""
        from .doctor_actions import ACTIONS

        actions_list = "\n".join([
            f"- {name}: {info['description']} (risk: {info['risk_level']})"
            for name, info in ACTIONS.items()
            if info.get("endpoint")  # Skip alert_only
        ])

        prompt = f"""You are Fleet Doctor, an autonomous AI managing a GPU compute cluster.

CURRENT PROBLEM:
{json.dumps(problem.to_dict(), indent=2)}

SYSTEM CONTEXT:
Active nodes: {fleet_context.get('active_nodes', 0)}
Total power: {fleet_context.get('total_power_w', 0)}W
Issues detected: {len(fleet_context.get('issues', []))}

{f'NODE DETAILS ({problem.node_id}):' if node_details else ''}
{json.dumps(node_details, indent=2) if node_details else 'N/A'}

AVAILABLE ACTIONS:
{actions_list}

Analyze this problem and respond with ONLY valid JSON (no markdown):
{{
  "diagnosis": "Brief explanation of the issue",
  "root_cause": "Likely root cause",
  "recommended_actions": [
    {{"action": "action_name", "params": {{}}, "reason": "why this action"}}
  ],
  "can_auto_fix": true or false,
  "risk_level": "low" or "medium" or "high",
  "manual_steps": ["steps if cannot auto-fix"]
}}"""

        return prompt

    def _default_diagnosis(self, problem: Problem) -> Dict[str, Any]:
        """Generate a default diagnosis when AI is unavailable."""
        default_action = PROBLEM_ACTION_MAP.get(problem.type.value, "alert_only")

        return {
            "diagnosis": f"Default handling for {problem.type.value}",
            "root_cause": "Unable to perform AI diagnosis",
            "recommended_actions": [
                {"action": default_action, "params": {}, "reason": "Default action for this problem type"}
            ] if default_action != "alert_only" else [],
            "can_auto_fix": problem.auto_fixable and default_action != "alert_only",
            "risk_level": problem.risk_level,
            "manual_steps": ["Check system logs", "Review problem details", "Take manual action if needed"]
        }

    async def _execute_action(
        self,
        problem: Problem,
        action_spec: Dict[str, Any]
    ) -> ActionResult:
        """Execute a remediation action."""
        action_name = action_spec.get("action", "alert_only")
        params = action_spec.get("params", {})

        # Get credential for node
        credential_id = await self._get_node_credential(problem.node_id)

        result = await self.action_executor.execute(
            action_name=action_name,
            node_id=problem.node_id,
            params=params,
            credential_id=credential_id
        )

        # Update cooldown and counter
        if problem.node_id:
            self.action_cooldowns[problem.node_id] = datetime.utcnow()
        self.actions_this_hour += 1

        return result

    async def _get_fleet_context(self) -> dict:
        """Get current fleet status for context."""
        context = {
            "active_nodes": 0,
            "total_power_w": 0,
            "issues": []
        }

        try:
            node_ids = await self.redis_client.smembers("nodes:active")
            context["active_nodes"] = len(node_ids)

            total_power = 0
            for nid in node_ids:
                hb = await self.redis_client.get(f"node:{nid}:heartbeat")
                if hb:
                    data = json.loads(hb)
                    total_power += data.get("power", {}).get("total_w", 0)

            context["total_power_w"] = round(total_power, 1)
        except Exception as e:
            context["error"] = str(e)

        return context

    async def _get_node_details(self, node_id: str) -> Optional[dict]:
        """Get detailed info about a specific node."""
        hb_json = await self.redis_client.get(f"node:{node_id}:heartbeat")
        if hb_json:
            return json.loads(hb_json)
        return None

    async def _get_node_credential(self, node_id: Optional[str]) -> Optional[str]:
        """Get credential ID for a node."""
        if not node_id:
            return None

        # Try to find credential by node mapping
        cred_id = await self.redis_client.get(f"node:{node_id}:credential")
        if cred_id:
            return cred_id

        # Fall back to default credential
        default_cred = await self.redis_client.get("fleet:default_credential")
        return default_cred

    async def _store_problems(self, problems: List[Problem]):
        """Store current problems in Redis."""
        problems_dict = {p.id: p.to_json() for p in problems}
        if problems_dict:
            await self.redis_client.hset("fleet:doctor:problems", mapping=problems_dict)
        else:
            await self.redis_client.delete("fleet:doctor:problems")

    async def _log_action(
        self,
        problem: Problem,
        diagnosis: dict,
        result: ActionResult
    ):
        """Log action to history."""
        entry = {
            "timestamp": datetime.utcnow().isoformat(),
            "problem": problem.to_dict(),
            "diagnosis": diagnosis,
            "result": result.to_dict()
        }

        await self.redis_client.lpush("fleet:doctor:history", json.dumps(entry))
        await self.redis_client.ltrim("fleet:doctor:history", 0, 99)  # Keep last 100

    async def _update_status(self, status: str, extra: dict = None):
        """Update doctor status in Redis."""
        status_data = {
            "status": status,
            "last_check": self.last_check.isoformat() if self.last_check else None,
            "problems_count": len(self.problems_found),
            "actions_this_hour": self.actions_this_hour,
            "config": self.config,
            "updated_at": datetime.utcnow().isoformat()
        }
        if extra:
            status_data.update(extra)

        await self.redis_client.set("fleet:doctor:status", json.dumps(status_data))

    async def _publish_event(self, event_type: str, data: dict):
        """Publish event to Redis pub/sub."""
        event = {
            "type": event_type,
            "data": data,
            "timestamp": datetime.utcnow().isoformat()
        }
        await self.redis_client.publish("fleet:doctor:events", json.dumps(event))

    async def get_status(self) -> dict:
        """Get current doctor status."""
        status_json = await self.redis_client.get("fleet:doctor:status")
        if status_json:
            return json.loads(status_json)
        return {"status": "unknown"}

    async def get_problems(self) -> List[dict]:
        """Get current problems."""
        problems = await self.redis_client.hgetall("fleet:doctor:problems")
        return [json.loads(p) for p in problems.values()]

    async def get_history(self, limit: int = 50) -> List[dict]:
        """Get action history."""
        history = await self.redis_client.lrange("fleet:doctor:history", 0, limit - 1)
        return [json.loads(h) for h in history]

    async def update_config(self, new_config: dict):
        """Update doctor configuration."""
        self.config.update(new_config)
        await self.redis_client.set("fleet:doctor:config", json.dumps(self.config))


# Global instance
fleet_doctor: Optional[FleetDoctor] = None


async def get_fleet_doctor() -> FleetDoctor:
    """Get or create the Fleet Doctor instance."""
    global fleet_doctor
    if fleet_doctor is None:
        fleet_doctor = FleetDoctor(
            redis_url=os.getenv("REDIS_URL", "redis://comfyui-redis:6379"),
            ollama_url=os.getenv("OLLAMA_URL", "http://jessica-ollama-gb10:11434"),
            api_url="http://localhost:8765",
            model=os.getenv("FLEET_DOCTOR_MODEL", "deepseek-coder:6.7b")
        )
        await fleet_doctor.connect()
    return fleet_doctor
