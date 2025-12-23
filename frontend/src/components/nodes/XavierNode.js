import React, { memo, useState, useEffect } from 'react';
import { Handle, Position } from 'reactflow';
import { Thermometer, MoreVertical, HardDrive, RefreshCw, Loader2, Check, X, ChevronDown, ChevronUp, Wifi, Server, Container, Database, Zap, Activity, Box } from 'lucide-react';
import clsx from 'clsx';
import MetricBar from './MetricBar';
import StatusDot from './StatusDot';

const API_URL = `http://${window.location.hostname}:8765/api`;

const clusterColors = {
  vision: { border: 'border-cluster-vision', bg: 'bg-cluster-vision/10', text: 'text-cluster-vision' },
  'media-gen': { border: 'border-cluster-media-gen', bg: 'bg-cluster-media-gen/10', text: 'text-cluster-media-gen' },
  'media-proc': { border: 'border-cluster-media-proc', bg: 'bg-cluster-media-proc/10', text: 'text-cluster-media-proc' },
  llm: { border: 'border-cluster-llm', bg: 'bg-cluster-llm/10', text: 'text-cluster-llm' },
  voice: { border: 'border-cluster-voice', bg: 'bg-cluster-voice/10', text: 'text-cluster-voice' },
  music: { border: 'border-cluster-music', bg: 'bg-cluster-music/10', text: 'text-cluster-music' },
  agentic: { border: 'border-cluster-agentic', bg: 'bg-cluster-agentic/10', text: 'text-cluster-agentic' },
  roamer: { border: 'border-cluster-roamer', bg: 'bg-cluster-roamer/10', text: 'text-cluster-roamer' },
  inference: { border: 'border-cluster-inference', bg: 'bg-cluster-inference/10', text: 'text-cluster-inference' },
  unassigned: { border: 'border-cluster-unassigned', bg: 'bg-cluster-unassigned/10', text: 'text-cluster-unassigned' },
  default: { border: 'border-border-default', bg: 'bg-bg-tertiary', text: 'text-text-muted' },
};

// Restart progress steps
const restartSteps = [
  { id: 'stop', label: 'Stopping agent' },
  { id: 'restart', label: 'Restarting' },
  { id: 'wait', label: 'Waiting' },
  { id: 'connect', label: 'Reconnecting' },
];

const XavierNode = ({ data, selected }) => {
  const {
    node_id,
    cpu = 0,
    memory = {},
    gpu = {},
    disk = {},
    cluster = 'default',
    ip,
    services = [],
    onDiskCleanup,
    power = {},
    activity = {}
  } = data;

  const [restarting, setRestarting] = useState(false);
  const [restartStep, setRestartStep] = useState(0);
  const [showTests, setShowTests] = useState(false);
  const [testResults, setTestResults] = useState(null);
  const [testing, setTesting] = useState(false);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchmarkResult, setBenchmarkResult] = useState(null);

  const diskPercent = disk?.percent || 0;
  const isDiskHigh = diskPercent > 60;
  const isDiskCritical = diskPercent > 80;

  const getNodeStatus = () => {
    if (isDiskCritical || (gpu?.temperature || 0) > 80) return 'error';
    if (cpu > 90 || (memory?.percent || 0) > 90 || isDiskHigh) return 'warning';
    return 'online';
  };

  const handleRestart = async (e) => {
    e.stopPropagation();
    if (!ip || restarting) return;

    if (!window.confirm(`Restart fleet-agent on ${node_id}?`)) return;

    setRestarting(true);
    setRestartStep(0);

    try {
      const username = localStorage.getItem('jetson_user') || 'jetson';
      const password = localStorage.getItem('jetson_pass') || '';

      // Step 1: Stopping
      setRestartStep(0);
      await new Promise(r => setTimeout(r, 500));

      // Step 2: Restarting
      setRestartStep(1);
      const res = await fetch(`${API_URL}/maintenance/restart-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_ip: ip, username, password }),
      });

      if (!res.ok) throw new Error('Restart failed');

      // Step 3: Waiting
      setRestartStep(2);
      await new Promise(r => setTimeout(r, 2000));

      // Step 4: Reconnecting
      setRestartStep(3);
      await new Promise(r => setTimeout(r, 2000));

      // Done
      setRestartStep(4);
    } catch (err) {
      console.error('Restart error:', err);
    } finally {
      setTimeout(() => {
        setRestarting(false);
        setRestartStep(0);
      }, 1000);
    }
  };

  const runTests = async (e) => {
    e.stopPropagation();
    if (!ip || testing) return;

    setTesting(true);
    setTestResults(null);

    try {
      const username = localStorage.getItem('jetson_user') || 'jetson';
      const password = localStorage.getItem('jetson_pass') || '';

      const res = await fetch(`${API_URL}/maintenance/health-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_ip: ip, username, password }),
      });

      if (res.ok) {
        const data = await res.json();
        setTestResults(data);
      } else {
        setTestResults({
          ssh: false,
          agent: false,
          docker: false,
          s3_mounts: false,
          error: 'Failed to run health checks'
        });
      }
    } catch (err) {
      setTestResults({
        ssh: false,
        agent: false,
        docker: false,
        s3_mounts: false,
        error: err.message
      });
    } finally {
      setTesting(false);
    }
  };

  const runBenchmark = async (e) => {
    e.stopPropagation();
    if (!ip || benchmarking) return;

    setBenchmarking(true);
    setBenchmarkResult(null);

    try {
      const username = localStorage.getItem('jetson_user') || 'jetson';
      const password = localStorage.getItem('jetson_pass') || '';

      // Start benchmark
      const res = await fetch(`${API_URL}/benchmark/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_ip: ip,
          username,
          password,
          tests: ['gpu', 'memory', 'storage']
        }),
      });

      if (res.ok) {
        const { task_id } = await res.json();

        // Poll for results
        let attempts = 0;
        const maxAttempts = 60; // 2 minutes max

        while (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 2000));
          const statusRes = await fetch(`${API_URL}/benchmark/status/${task_id}`);
          const status = await statusRes.json();

          if (status.status === 'completed') {
            setBenchmarkResult(status.results);
            break;
          } else if (status.status === 'error') {
            setBenchmarkResult({ error: status.error });
            break;
          }
          attempts++;
        }

        if (attempts >= maxAttempts) {
          setBenchmarkResult({ error: 'Benchmark timeout' });
        }
      } else {
        setBenchmarkResult({ error: 'Failed to start benchmark' });
      }
    } catch (err) {
      setBenchmarkResult({ error: err.message });
    } finally {
      setBenchmarking(false);
    }
  };

  const status = getNodeStatus();
  const clusterStyle = clusterColors[cluster] || clusterColors.default;

  const [fixingS3, setFixingS3] = useState(false);

  const fixS3Mounts = async (e) => {
    e.stopPropagation();
    if (!ip || fixingS3) return;

    setFixingS3(true);
    try {
      const username = localStorage.getItem('jetson_user') || 'jetson';
      const password = localStorage.getItem('jetson_pass') || '';

      const res = await fetch(`${API_URL}/maintenance/fix-s3-mounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_ip: ip, username, password }),
      });

      if (res.ok) {
        // Re-run tests to check if fixed
        await runTests(e);
      }
    } catch (err) {
      console.error('Fix S3 error:', err);
    } finally {
      setFixingS3(false);
    }
  };

  // Test checklist items
  const testItems = [
    { key: 'ssh', label: 'SSH Access', icon: Wifi },
    { key: 'agent', label: 'Fleet Agent', icon: Server },
    { key: 'docker', label: 'Docker', icon: Container },
    { key: 's3_mounts', label: 'S3 Mounts', icon: Database, fixable: true },
  ];

  const isComputing = activity?.status === 'computing';
  const isWorking = activity?.status === 'working';

  return (
    <div
      className={clsx(
        'relative rounded-lg border-2 w-56 transition-all duration-200',
        // Electric border effect when computing
        isComputing && 'electric-border electric-border-intense electric-border-gpu',
        isWorking && 'electric-border electric-border-pulse',
        clusterStyle.border,
        clusterStyle.bg,
        selected && 'ring-2 ring-text-accent ring-offset-2 ring-offset-bg-primary',
        status === 'warning' && !isComputing && 'glow-warning',
        status === 'error' && !isComputing && 'glow-error'
      )}
    >
      {/* Turbulent Electric Glow Layers (shown when computing) */}
      {isComputing && (
        <>
          <div className="electric-card-glow-1" />
          <div className="electric-card-glow-2" />
          <div className="electric-card-bg-glow" />
          <div
            className="absolute inset-0 rounded-lg pointer-events-none"
            style={{
              border: '2px solid #76b900',
              filter: 'url(#electric-turbulence-green)'
            }}
          />
        </>
      )}

      <Handle type="target" position={Position.Top} className="!bg-text-accent" />

      {/* Cluster Badge - Glass Tag Style */}
      {cluster && cluster !== 'default' && cluster !== 'unassigned' && (
        <div className={clsx(
          'glass-tag absolute -top-3 left-1/2 -translate-x-1/2 !py-1 !px-2.5 !text-[9px]',
          clusterStyle.text
        )}>
          {cluster}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <StatusDot status={status} />
          <div>
            <div className="font-semibold text-text-primary text-sm flex items-center gap-1">
              {node_id}
              {isDiskHigh && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDiskCleanup?.();
                  }}
                  className={clsx(
                    'px-1 py-0.5 text-[9px] rounded font-bold flex items-center gap-0.5 hover:opacity-80 transition-opacity',
                    isDiskCritical ? 'bg-status-error/20 text-status-error' : 'bg-status-warning/20 text-status-warning'
                  )}
                  title="Click to analyze and clean disk"
                >
                  <HardDrive size={8} />
                  {isDiskCritical ? 'FULL' : 'DISK'}
                </button>
              )}
            </div>
            {ip && <div className="text-text-muted text-xs">{ip}</div>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={runBenchmark}
            disabled={benchmarking}
            className={clsx(
              "p-1 rounded transition-colors",
              benchmarking
                ? "text-status-warning"
                : "text-text-muted hover:text-status-warning hover:bg-bg-hover"
            )}
            title="Run benchmark"
          >
            {benchmarking ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
          </button>
          <button
            onClick={handleRestart}
            disabled={restarting}
            className={clsx(
              "p-1 rounded transition-colors",
              restarting
                ? "text-text-accent"
                : "text-text-muted hover:text-text-accent hover:bg-bg-hover"
            )}
            title="Restart fleet-agent"
          >
            {restarting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setShowTests(!showTests); }}
            className="p-1 hover:bg-bg-hover rounded text-text-muted hover:text-text-primary"
          >
            {showTests ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Restart Progress Indicator */}
      {restarting && (
        <div className="px-3 py-2 bg-bg-secondary/50 border-b border-border-subtle">
          <div className="flex items-center justify-between mb-1.5">
            {restartSteps.map((step, i) => (
              <div key={step.id} className="flex flex-col items-center">
                <div className={clsx(
                  "w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold transition-all",
                  i < restartStep ? "bg-status-online text-white" :
                  i === restartStep ? "bg-text-accent text-white animate-pulse" :
                  "bg-bg-tertiary text-text-muted"
                )}>
                  {i < restartStep ? <Check size={10} /> : i + 1}
                </div>
              </div>
            ))}
          </div>
          <div className="text-center text-[10px] text-text-accent">
            {restartStep < restartSteps.length ? restartSteps[restartStep].label : 'Complete!'}
          </div>
        </div>
      )}

      {/* Metrics */}
      <div className="px-3 py-2 space-y-1.5">
        <MetricBar label="CPU" value={cpu} type="cpu" />
        <MetricBar label="GPU" value={gpu?.utilization || 0} type="gpu" />
        <MetricBar label="RAM" value={memory?.percent || 0} type="ram" />
        {disk?.percent !== undefined && (
          <MetricBar label="DSK" value={disk.percent} type="disk" />
        )}
      </div>

      {/* Power & Activity */}
      {(power?.total_w > 0 || activity?.status) && (
        <div className="px-3 py-1.5 border-t border-border-subtle">
          <div className="flex items-center justify-between text-xs">
            {/* Power */}
            {power?.total_w > 0 && (
              <div className="flex items-center gap-1">
                <Zap size={10} className="text-yellow-500" />
                <span className="font-mono text-text-primary">
                  {power.total_w.toFixed(1)}W
                </span>
              </div>
            )}
            {/* Activity Status */}
            {activity?.status && (
              <div className="flex items-center gap-1">
                <Activity size={10} className={clsx(
                  activity.status === 'computing' && 'text-green-500 animate-pulse',
                  activity.status === 'working' && 'text-blue-500',
                  activity.status === 'ready' && 'text-yellow-500',
                  activity.status === 'idle' && 'text-gray-500'
                )} />
                <span className={clsx(
                  'capitalize text-[10px]',
                  activity.status === 'computing' && 'text-green-500',
                  activity.status === 'working' && 'text-blue-500',
                  activity.status === 'ready' && 'text-yellow-500',
                  activity.status === 'idle' && 'text-gray-400'
                )}>
                  {activity.status}
                </span>
              </div>
            )}
            {/* Containers */}
            {activity?.containers > 0 && (
              <div className="flex items-center gap-1">
                <Box size={10} className="text-purple-400" />
                <span className="text-text-muted">{activity.containers}</span>
              </div>
            )}
          </div>
          {/* Activity Detail */}
          {activity?.detail && activity.status !== 'idle' && (
            <div className="mt-1 text-[9px] text-text-muted truncate">
              {activity.detail}
            </div>
          )}
        </div>
      )}

      {/* Temperature */}
      {gpu?.temperature && (
        <div className="px-3 py-1.5 border-t border-border-subtle flex items-center gap-2 text-xs">
          <Thermometer size={12} className={clsx(
            gpu.temperature > 75 ? 'text-status-error' : 'text-text-muted'
          )} />
          <span className={clsx(
            'font-mono',
            gpu.temperature > 75 ? 'text-status-error' : 'text-text-secondary'
          )}>
            {gpu.temperature}°C
          </span>
        </div>
      )}

      {/* Test Checklist */}
      {showTests && (
        <div className="px-3 py-2 border-t border-border-subtle bg-bg-secondary/30">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">Health Checks</span>
            <button
              onClick={runTests}
              disabled={testing}
              className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary hover:bg-bg-hover text-text-muted hover:text-text-primary flex items-center gap-1"
            >
              {testing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
              {testing ? 'Testing...' : 'Run Tests'}
            </button>
          </div>
          <div className="space-y-1">
            {testItems.map(item => {
              const Icon = item.icon;
              const result = testResults?.[item.key];
              const isPassed = result === true;
              const isFailed = result === false;
              const isUnknown = result === undefined || result === null;

              return (
                <div key={item.key} className="flex items-center justify-between py-0.5">
                  <div className="flex items-center gap-1.5">
                    <Icon size={10} className="text-text-muted" />
                    <span className="text-[10px] text-text-secondary">{item.label}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {isFailed && item.fixable && (
                      <button
                        onClick={fixS3Mounts}
                        disabled={fixingS3}
                        className="text-[8px] px-1 py-0.5 rounded bg-text-accent/20 text-text-accent hover:bg-text-accent/30 transition-colors"
                      >
                        {fixingS3 ? <Loader2 size={8} className="animate-spin" /> : 'Fix'}
                      </button>
                    )}
                    <div className={clsx(
                      "w-4 h-4 rounded flex items-center justify-center",
                      isPassed && "bg-status-online/20",
                      isFailed && "bg-status-error/20",
                      isUnknown && "bg-bg-tertiary"
                    )}>
                      {isPassed && <Check size={10} className="text-status-online" />}
                      {isFailed && <X size={10} className="text-status-error" />}
                      {isUnknown && <span className="text-[8px] text-text-muted">-</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {testResults?.error && (
            <div className="mt-1.5 text-[9px] text-status-error truncate" title={testResults.error}>
              {testResults.error}
            </div>
          )}
        </div>
      )}

      {/* Benchmark Results */}
      {(benchmarking || benchmarkResult) && (
        <div className="px-3 py-2 border-t border-border-subtle bg-status-warning/5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold text-status-warning uppercase tracking-wide flex items-center gap-1">
              <Zap size={10} /> Benchmark
            </span>
            {benchmarking && <Loader2 size={10} className="animate-spin text-status-warning" />}
          </div>
          {benchmarkResult && !benchmarkResult.error && (
            <div className="space-y-1 text-[9px]">
              {benchmarkResult.gpu && (
                <div className="flex justify-between">
                  <span className="text-text-muted">GPU:</span>
                  <span className="text-text-secondary font-mono">
                    {benchmarkResult.gpu['4096x4096']?.gflops
                      ? `${Math.round(benchmarkResult.gpu['4096x4096'].gflops)} GFLOPS`
                      : benchmarkResult.gpu.status || 'N/A'}
                  </span>
                </div>
              )}
              {benchmarkResult.storage?.write_speed && (
                <div className="flex justify-between">
                  <span className="text-text-muted">Storage:</span>
                  <span className="text-text-secondary font-mono">
                    W: {benchmarkResult.storage.write_speed} | R: {benchmarkResult.storage.read_speed || 'N/A'}
                  </span>
                </div>
              )}
              {benchmarkResult.memory?.output && (
                <div className="flex justify-between">
                  <span className="text-text-muted">Memory:</span>
                  <span className="text-text-secondary font-mono truncate max-w-[120px]" title={benchmarkResult.memory.output}>
                    {benchmarkResult.memory.output.split('\n')[0]}
                  </span>
                </div>
              )}
            </div>
          )}
          {benchmarkResult?.error && (
            <div className="text-[9px] text-status-error">{benchmarkResult.error}</div>
          )}
          {benchmarking && (
            <div className="text-[9px] text-text-muted">Running tests...</div>
          )}
        </div>
      )}

      {/* Services (if any) */}
      {services.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border-subtle">
          <div className="flex flex-wrap gap-1">
            {services.slice(0, 3).map((svc, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 text-xs bg-bg-secondary rounded text-text-secondary"
              >
                {svc}
              </span>
            ))}
            {services.length > 3 && (
              <span className="px-1.5 py-0.5 text-xs bg-bg-secondary rounded text-text-muted">
                +{services.length - 3}
              </span>
            )}
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="!bg-text-accent" />
    </div>
  );
};

export default memo(XavierNode);
