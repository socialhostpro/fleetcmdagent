import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Brain,
  Play,
  Square,
  RefreshCw,
  Server,
  Zap,
  Eye,
  ChevronDown,
  AlertCircle,
  CheckCircle2
} from 'lucide-react';
import clsx from 'clsx';
import axios from 'axios';
import { AttentionHeatmap, TokenFlow, PerformancePanel, LayerSelector } from '../components/llm';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:8765';

/**
 * LLMMonitorView - Real-time LLM visualization dashboard
 *
 * Monitors Ollama and other LLM backends, visualizing:
 * - Attention patterns as heatmaps
 * - Token flow and generation progress
 * - Performance metrics (tokens/sec, latency, memory)
 */
const LLMMonitorView = () => {
  // State
  const [backends, setBackends] = useState([]);
  const [selectedBackend, setSelectedBackend] = useState('ollama');
  const [selectedModel, setSelectedModel] = useState('llama3.2');
  const [prompt, setPrompt] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [sessionStatus, setSessionStatus] = useState('idle'); // idle, running, completed, error
  const [attentionData, setAttentionData] = useState({ attention_heads: [], tokens: [] });
  const [metrics, setMetrics] = useState({});
  const [selectedLayer, setSelectedLayer] = useState(0);
  const [selectedHead, setSelectedHead] = useState(0);
  const [numLayers, setNumLayers] = useState(12);
  const [numHeads, setNumHeads] = useState(12);
  const [generatedText, setGeneratedText] = useState('');
  const [error, setError] = useState(null);

  const wsRef = useRef(null);

  // Fetch available backends on mount
  useEffect(() => {
    fetchBackends();
  }, []);

  const fetchBackends = async () => {
    try {
      const response = await axios.get(`${API_BASE}/api/llm-monitor/backends`);
      setBackends(response.data);
      if (response.data.length > 0) {
        setSelectedBackend(response.data[0].name);
        if (response.data[0].models.length > 0) {
          setSelectedModel(response.data[0].models[0]);
        }
      }
    } catch (err) {
      console.error('Failed to fetch backends:', err);
      // Set default backend even if fetch fails
      setBackends([{ name: 'ollama', status: 'unknown', models: ['llama3.2'] }]);
    }
  };

  // Start monitoring session
  const startSession = async () => {
    if (!prompt.trim()) return;

    setError(null);
    setSessionStatus('running');
    setAttentionData({ attention_heads: [], tokens: [] });
    setGeneratedText('');
    setMetrics({});

    try {
      const response = await axios.post(`${API_BASE}/api/llm-monitor/session/start`, {
        prompt: prompt.trim(),
        backend: selectedBackend,
        model: selectedModel,
        extract_attention: true,
        extract_embeddings: true
      });

      const { session_id } = response.data;
      setSessionId(session_id);

      // Connect to WebSocket for streaming updates
      connectWebSocket(session_id);
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
      setSessionStatus('error');
    }
  };

  // Connect to WebSocket for real-time updates
  const connectWebSocket = useCallback((sid) => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const wsUrl = `${API_BASE.replace('http', 'ws')}/api/llm-monitor/ws/monitor/${sid}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected for session:', sid);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.error) {
          setError(data.error);
          setSessionStatus('error');
          return;
        }

        if (data.type === 'connected') {
          return;
        }

        // Update attention data
        if (data.tokens) {
          setAttentionData({
            attention_heads: data.attention_heads || [],
            tokens: data.tokens || []
          });
        }

        // Update layer/head counts
        if (data.num_layers) setNumLayers(data.num_layers);
        if (data.num_heads) setNumHeads(data.num_heads);

        // Update generated text
        if (data.text) {
          setGeneratedText(data.text);
        }

        // Update metrics
        setMetrics({
          tokens_per_second: data.tokens_per_second || 0,
          latency_ms: (data.generation_time || 0) * 1000,
          memory_mb: 0,
          total_tokens: data.total_tokens || 0,
          generation_time: data.generation_time || 0
        });

        // Check for completion
        if (data.status === 'completed') {
          setSessionStatus('completed');
        }
      } catch (err) {
        console.error('WebSocket message parse error:', err);
      }
    };

    ws.onerror = (event) => {
      console.error('WebSocket error:', event);
      setError('WebSocket connection failed');
    };

    ws.onclose = () => {
      console.log('WebSocket closed');
      if (sessionStatus === 'running') {
        setSessionStatus('completed');
      }
    };

    wsRef.current = ws;
  }, [sessionStatus]);

  // Stop session
  const stopSession = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    setSessionStatus('idle');
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const selectedBackendData = backends.find(b => b.name === selectedBackend);

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 bg-bg-secondary border-b border-border-subtle">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Brain className="text-text-accent" size={24} />
            <div>
              <h1 className="text-lg font-bold text-text-primary">LLM Monitor</h1>
              <p className="text-xs text-text-muted">Real-time transformer visualization</p>
            </div>
          </div>

          {/* Backend Status */}
          <div className="flex items-center gap-4">
            {/* Backend Selector */}
            <div className="flex items-center gap-2">
              <Server size={14} className="text-text-muted" />
              <select
                value={selectedBackend}
                onChange={(e) => setSelectedBackend(e.target.value)}
                className="bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-text-primary"
                disabled={sessionStatus === 'running'}
              >
                {backends.map(b => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))}
              </select>

              {/* Model Selector */}
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-text-primary"
                disabled={sessionStatus === 'running'}
              >
                {(selectedBackendData?.models || ['llama3.2']).map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            {/* Status Indicator */}
            <div className={clsx(
              'flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium',
              sessionStatus === 'idle' && 'bg-bg-tertiary text-text-muted',
              sessionStatus === 'running' && 'bg-status-online/20 text-status-online',
              sessionStatus === 'completed' && 'bg-cluster-spark/20 text-cluster-spark',
              sessionStatus === 'error' && 'bg-status-error/20 text-status-error'
            )}>
              {sessionStatus === 'running' && <RefreshCw size={12} className="animate-spin" />}
              {sessionStatus === 'completed' && <CheckCircle2 size={12} />}
              {sessionStatus === 'error' && <AlertCircle size={12} />}
              {sessionStatus.toUpperCase()}
            </div>
          </div>
        </div>
      </div>

      {/* Prompt Input */}
      <div className="shrink-0 px-4 py-3 bg-bg-secondary border-b border-border-subtle">
        <div className="flex gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter your prompt to analyze..."
            className="flex-1 bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-text-accent"
            rows={2}
            disabled={sessionStatus === 'running'}
          />
          <div className="flex flex-col gap-2">
            <button
              onClick={sessionStatus === 'running' ? stopSession : startSession}
              disabled={!prompt.trim() && sessionStatus !== 'running'}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all',
                sessionStatus === 'running'
                  ? 'bg-status-error text-white hover:bg-status-error/80'
                  : 'bg-text-accent text-bg-primary hover:bg-text-accent/80',
                !prompt.trim() && sessionStatus !== 'running' && 'opacity-50 cursor-not-allowed'
              )}
            >
              {sessionStatus === 'running' ? (
                <>
                  <Square size={16} />
                  Stop
                </>
              ) : (
                <>
                  <Play size={16} />
                  Analyze
                </>
              )}
            </button>
            <button
              onClick={fetchBackends}
              className="flex items-center justify-center gap-1 px-2 py-1 rounded text-xs text-text-muted hover:text-text-primary bg-bg-tertiary border border-border-subtle"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-2 px-3 py-2 bg-status-error/10 border border-status-error/20 rounded text-sm text-status-error">
            {error}
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Controls & Token Flow */}
        <div className="w-80 shrink-0 bg-bg-secondary border-r border-border-subtle flex flex-col overflow-hidden">
          {/* Layer/Head Selector */}
          <div className="p-4 border-b border-border-subtle">
            <LayerSelector
              numLayers={numLayers}
              numHeads={numHeads}
              selectedLayer={selectedLayer}
              selectedHead={selectedHead}
              onLayerChange={setSelectedLayer}
              onHeadChange={setSelectedHead}
            />
          </div>

          {/* Token Flow */}
          <div className="flex-1 p-4 overflow-auto">
            <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
              <Eye size={14} />
              Token Flow
            </h3>
            <TokenFlow
              tokens={attentionData.tokens}
              currentPosition={attentionData.tokens.length - 1}
              promptLength={prompt.split(/\s+/).length} // Approximate
              showLogProbs={true}
            />
          </div>

          {/* Generated Text */}
          {generatedText && (
            <div className="p-4 border-t border-border-subtle">
              <h3 className="text-sm font-semibold text-text-primary mb-2">Generated</h3>
              <div className="bg-bg-tertiary rounded p-2 text-xs text-text-secondary max-h-32 overflow-auto font-mono">
                {generatedText}
              </div>
            </div>
          )}
        </div>

        {/* Center - Attention Heatmap */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="shrink-0 px-4 py-2 border-b border-border-subtle flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Zap size={14} />
              Attention Pattern
              <span className="text-xs text-text-muted font-normal">
                (Layer {selectedLayer + 1}, Head {selectedHead + 1})
              </span>
            </h3>
          </div>
          <div className="flex-1 p-4 overflow-auto">
            <AttentionHeatmap
              attentionHeads={attentionData.attention_heads}
              tokens={attentionData.tokens}
              selectedLayer={selectedLayer}
              selectedHead={selectedHead}
              className="h-full"
            />
          </div>
        </div>

        {/* Right Panel - Performance Metrics */}
        <div className="w-72 shrink-0 bg-bg-secondary border-l border-border-subtle p-4 overflow-auto">
          <h3 className="text-sm font-semibold text-text-primary mb-4 flex items-center gap-2">
            <Zap size={14} />
            Performance
          </h3>
          <PerformancePanel
            metrics={metrics}
            isStreaming={sessionStatus === 'running'}
          />

          {/* Model Info */}
          <div className="mt-6">
            <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
              Model Info
            </h4>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-text-muted">Backend</span>
                <span className="text-text-primary">{selectedBackend}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Model</span>
                <span className="text-text-primary">{selectedModel}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Layers</span>
                <span className="text-text-primary">{numLayers}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Heads/Layer</span>
                <span className="text-text-primary">{numHeads}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-muted">Proxy Model</span>
                <span className="text-text-primary">GPT-2</span>
              </div>
            </div>
          </div>

          {/* Legend */}
          <div className="mt-6">
            <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
              Attention Legend
            </h4>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-3 rounded" style={{
                background: 'linear-gradient(to right, #0a1428, #3cc9e8, #ffeb3b)'
              }} />
            </div>
            <div className="flex justify-between text-[10px] text-text-muted mt-1">
              <span>Low</span>
              <span>High</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LLMMonitorView;
