import { useState, useEffect, useCallback, useRef } from 'react';

const WS_URL = `ws://${window.location.hostname}:8765`;
const API_URL = `http://${window.location.hostname}:8765/api`;

export const useMetricsWebSocket = () => {
  const [nodes, setNodes] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [usePolling, setUsePolling] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const pollingRef = useRef(null);
  const wsFailCount = useRef(0);

  // REST API polling fallback
  const fetchNodes = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/nodes/`);
      if (res.ok) {
        const data = await res.json();
        setNodes(data);
        setLastUpdate(new Date());
        setIsConnected(true);
      }
    } catch (err) {
      console.error('Failed to fetch nodes:', err);
      setIsConnected(false);
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    console.log('Starting REST polling fallback');
    setUsePolling(true);
    fetchNodes(); // Immediate fetch
    pollingRef.current = setInterval(fetchNodes, 2000);
  }, [fetchNodes]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setUsePolling(false);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // If WebSocket has failed multiple times, use polling
    if (wsFailCount.current >= 2) {
      startPolling();
      return;
    }

    try {
      const ws = new WebSocket(`${WS_URL}/ws/metrics`);

      ws.onopen = () => {
        console.log('WebSocket connected');
        setIsConnected(true);
        wsFailCount.current = 0;
        stopPolling();
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'nodes_update') {
            setNodes(message.data);
            setLastUpdate(new Date());
          }
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        setIsConnected(false);
        wsFailCount.current++;

        if (wsFailCount.current >= 2) {
          console.log('WebSocket failed, switching to REST polling');
          startPolling();
        } else {
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, 2000);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        ws.close();
      };

      wsRef.current = ws;
    } catch (err) {
      console.error('WebSocket connection error:', err);
      wsFailCount.current++;
      if (wsFailCount.current >= 2) {
        startPolling();
      }
    }
  }, [startPolling, stopPolling]);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    stopPolling();
  }, [stopPolling]);

  const sendPing = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send('ping');
    }
  }, []);

  const reconnect = useCallback(() => {
    wsFailCount.current = 0;
    stopPolling();
    disconnect();
    setTimeout(() => connect(), 100);
  }, [connect, disconnect, stopPolling]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  return {
    nodes,
    isConnected,
    lastUpdate,
    reconnect,
    sendPing,
    usePolling,
  };
};

export const useLogsWebSocket = (nodeId) => {
  const [logs, setLogs] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!nodeId) return;

    const ws = new WebSocket(`${WS_URL}/ws/logs/${nodeId}`);

    ws.onopen = () => {
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'log') {
          setLogs((prev) => [...prev.slice(-1000), message.data]); // Keep last 1000 logs
        }
      } catch (error) {
        console.error('Failed to parse log message:', error);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
    };

    wsRef.current = ws;

    return () => {
      ws.close();
    };
  }, [nodeId]);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return {
    logs,
    isConnected,
    clearLogs,
  };
};

export default useMetricsWebSocket;
