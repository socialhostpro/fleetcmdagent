import { useEffect, useRef, useCallback, useState } from 'react';
import useAgentStore from '../stores/agentStore';
import useMetricsStore from '../stores/metricsStore';
import useAlertStore from '../stores/alertStore';
import useJobStore from '../stores/jobStore';

const WS_URL = process.env.REACT_APP_WS_URL || 'ws://192.168.1.214:8765';

/**
 * Fleet WebSocket Hook - Manages real-time connections to the fleet
 */
export function useFleetWebSocket() {
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  const updateAgentMetrics = useAgentStore(state => state.updateAgentMetrics);
  const updateMetrics = useMetricsStore(state => state.updateMetrics);
  const addAlert = useAlertStore(state => state.addAlert);
  const updateAlert = useAlertStore(state => state.updateAlert);
  const removeAlert = useAlertStore(state => state.removeAlert);
  const updateJob = useJobStore(state => state.updateJob);
  const addJob = useJobStore(state => state.addJob);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    try {
      wsRef.current = new WebSocket(`${WS_URL}/ws`);

      wsRef.current.onopen = () => {
        console.log('Fleet WebSocket connected');
        setConnected(true);
        setError(null);
      };

      wsRef.current.onclose = () => {
        console.log('Fleet WebSocket disconnected');
        setConnected(false);

        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('Attempting to reconnect...');
          connect();
        }, 3000);
      };

      wsRef.current.onerror = (event) => {
        console.error('Fleet WebSocket error:', event);
        setError('WebSocket connection failed');
      };

      wsRef.current.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleMessage(message);
        } catch (e) {
          console.error('Failed to parse WebSocket message:', e);
        }
      };
    } catch (e) {
      console.error('Failed to create WebSocket:', e);
      setError(e.message);
    }
  }, []);

  const handleMessage = useCallback((message) => {
    const { type, data, channel } = message;

    switch (type) {
      case 'metrics':
        // Update agent and metrics stores
        if (data?.node_id) {
          updateAgentMetrics(data.node_id, data);
          updateMetrics(data.node_id, data);
        }
        break;

      case 'new_alert':
        addAlert(data.alert || data);
        break;

      case 'alert_acknowledged':
        updateAlert(data.alert_id, { status: 'acknowledged' });
        break;

      case 'alert_resolved':
        removeAlert(data.alert_id);
        break;

      case 'job_progress':
        updateJob(data.job_id, { progress: data.progress });
        break;

      case 'job_complete':
        updateJob(data.job_id, { status: 'completed', result: data.result });
        break;

      case 'job_failed':
        updateJob(data.job_id, { status: 'failed', error: data.error });
        break;

      case 'job_queued':
        addJob(data);
        break;

      case 'node_update':
        // Handle general node updates
        if (data?.node_id) {
          updateAgentMetrics(data.node_id, data);
        }
        break;

      default:
        console.log('Unknown WebSocket message type:', type, data);
    }
  }, [updateAgentMetrics, updateMetrics, addAlert, updateAlert, removeAlert, updateJob, addJob]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
  }, []);

  const send = useCallback((message) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected, cannot send message');
    }
  }, []);

  // Connect on mount
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    connected,
    error,
    connect,
    disconnect,
    send,
  };
}

/**
 * Hook for subscribing to a specific agent's metrics
 */
export function useAgentMetricsSubscription(nodeId) {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const updateAgentMetrics = useAgentStore(state => state.updateAgentMetrics);
  const updateMetrics = useMetricsStore(state => state.updateMetrics);

  useEffect(() => {
    if (!nodeId) return;

    wsRef.current = new WebSocket(`${WS_URL}/api/agents/ws/${nodeId}`);

    wsRef.current.onopen = () => setConnected(true);
    wsRef.current.onclose = () => setConnected(false);

    wsRef.current.onmessage = (event) => {
      try {
        const { data } = JSON.parse(event.data);
        if (data) {
          updateAgentMetrics(nodeId, data);
          updateMetrics(nodeId, data);
        }
      } catch (e) {
        console.error('Failed to parse agent metrics:', e);
      }
    };

    return () => {
      wsRef.current?.close();
    };
  }, [nodeId, updateAgentMetrics, updateMetrics]);

  return { connected };
}

/**
 * Hook for subscribing to alerts
 */
export function useAlertSubscription() {
  const wsRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const addAlert = useAlertStore(state => state.addAlert);
  const updateAlert = useAlertStore(state => state.updateAlert);
  const removeAlert = useAlertStore(state => state.removeAlert);

  useEffect(() => {
    wsRef.current = new WebSocket(`${WS_URL}/api/alerts/ws`);

    wsRef.current.onopen = () => setConnected(true);
    wsRef.current.onclose = () => setConnected(false);

    wsRef.current.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case 'new_alert':
            addAlert(message.alert);
            break;
          case 'alert_acknowledged':
            updateAlert(message.alert_id, { status: 'acknowledged' });
            break;
          case 'alert_resolved':
            removeAlert(message.alert_id);
            break;
          default:
            break;
        }
      } catch (e) {
        console.error('Failed to parse alert message:', e);
      }
    };

    return () => {
      wsRef.current?.close();
    };
  }, [addAlert, updateAlert, removeAlert]);

  return { connected };
}

export default useFleetWebSocket;
