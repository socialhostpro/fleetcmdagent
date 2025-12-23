"""
Alerts API

Endpoints for managing fleet alerts.
"""
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from typing import Optional, List
import os
import json
import redis.asyncio as redis

router = APIRouter()

REDIS_URL = os.getenv("REDIS_URL", "redis://comfyui-redis:6379")


class AcknowledgeRequest(BaseModel):
    acknowledged_by: str = "user"


class AlertRuleUpdate(BaseModel):
    enabled: Optional[bool] = None
    threshold: Optional[float] = None
    duration_seconds: Optional[int] = None
    cooldown_seconds: Optional[int] = None


async def get_redis():
    return redis.from_url(REDIS_URL, decode_responses=True)


@router.get("")
async def list_alerts(
    status: Optional[str] = None,  # active, acknowledged, resolved
    severity: Optional[str] = None,  # info, warning, error, critical
    node_id: Optional[str] = None,
    limit: int = 100,
):
    """List alerts with optional filters."""
    r = await get_redis()
    try:
        if status == "active":
            alert_ids = await r.smembers("alerts:active")
        else:
            alert_ids = await r.zrevrange("alerts:history", 0, limit - 1)

        alerts = []
        for alert_id in alert_ids:
            alert_data = await r.hget(f"alert:{alert_id}", "data")
            if not alert_data:
                continue

            alert = json.loads(alert_data)

            # Apply filters
            if status and alert.get("status") != status:
                continue
            if severity and alert.get("severity") != severity:
                continue
            if node_id and alert.get("node_id") != node_id:
                continue

            alerts.append(alert)

            if len(alerts) >= limit:
                break

        # Sort by severity then created_at
        severity_order = {"critical": 0, "error": 1, "warning": 2, "info": 3}
        alerts.sort(key=lambda a: (severity_order.get(a.get("severity", "info"), 4), a.get("created_at", "")))

        return {
            "alerts": alerts,
            "total": len(alerts),
            "active_count": await r.scard("alerts:active"),
        }
    finally:
        await r.close()


@router.get("/active")
async def get_active_alerts():
    """Get all active (non-resolved) alerts."""
    r = await get_redis()
    try:
        alert_ids = await r.smembers("alerts:active")
        alerts = []

        for alert_id in alert_ids:
            alert_data = await r.hget(f"alert:{alert_id}", "data")
            if alert_data:
                alerts.append(json.loads(alert_data))

        # Sort by severity then created_at
        severity_order = {"critical": 0, "error": 1, "warning": 2, "info": 3}
        alerts.sort(key=lambda a: (severity_order.get(a.get("severity", "info"), 4), a.get("created_at", "")))

        return {
            "alerts": alerts,
            "total": len(alerts),
            "by_severity": {
                "critical": sum(1 for a in alerts if a.get("severity") == "critical"),
                "error": sum(1 for a in alerts if a.get("severity") == "error"),
                "warning": sum(1 for a in alerts if a.get("severity") == "warning"),
                "info": sum(1 for a in alerts if a.get("severity") == "info"),
            }
        }
    finally:
        await r.close()


@router.get("/{alert_id}")
async def get_alert(alert_id: str):
    """Get a specific alert."""
    r = await get_redis()
    try:
        alert_data = await r.hget(f"alert:{alert_id}", "data")
        if not alert_data:
            raise HTTPException(status_code=404, detail=f"Alert {alert_id} not found")
        return json.loads(alert_data)
    finally:
        await r.close()


@router.post("/{alert_id}/acknowledge")
async def acknowledge_alert(alert_id: str, request: AcknowledgeRequest):
    """Acknowledge an alert."""
    from datetime import datetime

    r = await get_redis()
    try:
        alert_data = await r.hget(f"alert:{alert_id}", "data")
        if not alert_data:
            raise HTTPException(status_code=404, detail=f"Alert {alert_id} not found")

        alert = json.loads(alert_data)
        alert["status"] = "acknowledged"
        alert["acknowledged_by"] = request.acknowledged_by
        alert["acknowledged_at"] = datetime.utcnow().isoformat()
        alert["updated_at"] = datetime.utcnow().isoformat()

        await r.hset(f"alert:{alert_id}", mapping={"data": json.dumps(alert)})

        # Publish update
        await r.publish("alerts", json.dumps({
            "type": "alert_acknowledged",
            "alert_id": alert_id,
            "acknowledged_by": request.acknowledged_by
        }))

        return alert
    finally:
        await r.close()


@router.post("/{alert_id}/resolve")
async def resolve_alert(alert_id: str):
    """Resolve an alert."""
    from datetime import datetime

    r = await get_redis()
    try:
        alert_data = await r.hget(f"alert:{alert_id}", "data")
        if not alert_data:
            raise HTTPException(status_code=404, detail=f"Alert {alert_id} not found")

        alert = json.loads(alert_data)
        alert["status"] = "resolved"
        alert["resolved_at"] = datetime.utcnow().isoformat()
        alert["updated_at"] = datetime.utcnow().isoformat()

        await r.hset(f"alert:{alert_id}", mapping={"data": json.dumps(alert)})
        await r.srem("alerts:active", alert_id)

        # Publish update
        await r.publish("alerts", json.dumps({
            "type": "alert_resolved",
            "alert_id": alert_id
        }))

        return alert
    finally:
        await r.close()


@router.delete("/{alert_id}")
async def delete_alert(alert_id: str):
    """Delete an alert from history."""
    r = await get_redis()
    try:
        await r.srem("alerts:active", alert_id)
        await r.zrem("alerts:history", alert_id)
        await r.delete(f"alert:{alert_id}")
        return {"status": "deleted", "alert_id": alert_id}
    finally:
        await r.close()


@router.get("/rules/list")
async def list_rules():
    """List all alert rules."""
    r = await get_redis()
    try:
        rules_data = await r.get("alert:rules")
        if rules_data:
            return {"rules": json.loads(rules_data)}

        # Return default rules if none configured
        from services.alert_manager import AlertManager
        default_rules = []
        for rule in AlertManager.DEFAULT_RULES:
            default_rules.append({
                "id": rule.id,
                "name": rule.name,
                "description": rule.description,
                "severity": rule.severity.value,
                "condition": rule.condition,
                "threshold": rule.threshold,
                "duration_seconds": rule.duration_seconds,
                "cooldown_seconds": rule.cooldown_seconds,
                "enabled": rule.enabled,
            })
        return {"rules": default_rules}
    finally:
        await r.close()


@router.patch("/rules/{rule_id}")
async def update_rule(rule_id: str, update: AlertRuleUpdate):
    """Update an alert rule."""
    r = await get_redis()
    try:
        rules_data = await r.get("alert:rules")
        if not rules_data:
            raise HTTPException(status_code=404, detail="No rules configured")

        rules = json.loads(rules_data)
        found = False

        for rule in rules:
            if rule["id"] == rule_id:
                if update.enabled is not None:
                    rule["enabled"] = update.enabled
                if update.threshold is not None:
                    rule["threshold"] = update.threshold
                if update.duration_seconds is not None:
                    rule["duration_seconds"] = update.duration_seconds
                if update.cooldown_seconds is not None:
                    rule["cooldown_seconds"] = update.cooldown_seconds
                found = True
                break

        if not found:
            raise HTTPException(status_code=404, detail=f"Rule {rule_id} not found")

        await r.set("alert:rules", json.dumps(rules))
        return {"status": "updated", "rule_id": rule_id}
    finally:
        await r.close()


@router.websocket("/ws")
async def alerts_websocket(websocket: WebSocket):
    """WebSocket for real-time alert updates."""
    await websocket.accept()

    r = await get_redis()
    pubsub = r.pubsub()

    try:
        await pubsub.subscribe("alerts")

        async for message in pubsub.listen():
            if message['type'] == 'message':
                await websocket.send_json(json.loads(message['data']))

    except WebSocketDisconnect:
        pass
    finally:
        await pubsub.unsubscribe()
        await r.close()
