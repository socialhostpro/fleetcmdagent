import { create } from 'zustand';
import api from '../api';

/**
 * Metrics Store - Manages real-time metrics and historical data
 */
const useMetricsStore = create((set, get) => ({
  // State
  nodeMetrics: {}, // { nodeId: { current: {...}, history: [...] } }
  clusterMetrics: {}, // { cluster: { totalGpus, avgUtilization, ... } }
  loading: false,
  error: null,

  // Get current metrics for a node
  getNodeMetrics: (nodeId) => get().nodeMetrics[nodeId]?.current || null,

  // Get metrics history for a node
  getNodeHistory: (nodeId) => get().nodeMetrics[nodeId]?.history || [],

  // Get aggregated GPU utilization across all nodes
  getAverageGpuUtilization: () => {
    const nodes = Object.values(get().nodeMetrics);
    if (nodes.length === 0) return 0;

    let totalUtil = 0;
    let gpuCount = 0;

    nodes.forEach(node => {
      const gpus = node.current?.gpus || [];
      gpus.forEach(gpu => {
        totalUtil += gpu.utilization || 0;
        gpuCount++;
      });
    });

    return gpuCount > 0 ? Math.round(totalUtil / gpuCount) : 0;
  },

  // Actions
  updateMetrics: (nodeId, metrics) => {
    set(state => {
      const existing = state.nodeMetrics[nodeId] || { current: null, history: [] };
      const history = [...existing.history, metrics].slice(-300); // Keep last 5 minutes at 1/sec

      return {
        nodeMetrics: {
          ...state.nodeMetrics,
          [nodeId]: {
            current: metrics,
            history,
          },
        },
      };
    });

    // Update cluster aggregates
    get().updateClusterMetrics();
  },

  updateClusterMetrics: () => {
    const nodes = get().nodeMetrics;
    const clusters = {};

    Object.entries(nodes).forEach(([nodeId, data]) => {
      const cluster = data.current?.cluster || 'default';
      if (!clusters[cluster]) {
        clusters[cluster] = {
          name: cluster,
          nodeCount: 0,
          onlineNodes: 0,
          totalGpus: 0,
          avgGpuUtil: 0,
          avgGpuTemp: 0,
          totalGpuUtil: 0,
          totalGpuTemp: 0,
          gpuCount: 0,
        };
      }

      clusters[cluster].nodeCount++;
      if (data.current?.status === 'online') {
        clusters[cluster].onlineNodes++;
      }

      const gpus = data.current?.gpus || [];
      gpus.forEach(gpu => {
        clusters[cluster].totalGpus++;
        clusters[cluster].totalGpuUtil += gpu.utilization || 0;
        clusters[cluster].totalGpuTemp += gpu.temperature || 0;
        clusters[cluster].gpuCount++;
      });
    });

    // Calculate averages
    Object.values(clusters).forEach(cluster => {
      if (cluster.gpuCount > 0) {
        cluster.avgGpuUtil = Math.round(cluster.totalGpuUtil / cluster.gpuCount);
        cluster.avgGpuTemp = Math.round(cluster.totalGpuTemp / cluster.gpuCount);
      }
    });

    set({ clusterMetrics: clusters });
  },

  fetchNodeMetrics: async (nodeId, duration = '1h') => {
    set({ loading: true, error: null });
    try {
      const response = await api.get(`/agents/${nodeId}/metrics`, {
        params: { duration },
      });

      set(state => ({
        nodeMetrics: {
          ...state.nodeMetrics,
          [nodeId]: {
            current: state.nodeMetrics[nodeId]?.current || null,
            history: response.data.metrics || [],
          },
        },
        loading: false,
      }));

      return response.data;
    } catch (error) {
      set({ error: error.message, loading: false });
      return null;
    }
  },

  clearNodeMetrics: (nodeId) => {
    set(state => {
      const { [nodeId]: _, ...rest } = state.nodeMetrics;
      return { nodeMetrics: rest };
    });
  },

  clearAllMetrics: () => {
    set({ nodeMetrics: {}, clusterMetrics: {} });
  },
}));

export default useMetricsStore;
