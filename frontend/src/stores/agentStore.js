import { create } from 'zustand';
import api from '../api';

/**
 * Agent Store - Manages fleet agent state
 */
const useAgentStore = create((set, get) => ({
  // State
  agents: [],
  selectedAgent: null,
  loading: false,
  error: null,
  lastUpdate: null,

  // Computed
  getAgentById: (nodeId) => get().agents.find(a => a.node_id === nodeId),
  getAgentsByCluster: (cluster) => get().agents.filter(a => a.cluster === cluster),
  getOnlineAgents: () => get().agents.filter(a => a.status === 'online'),
  getOfflineAgents: () => get().agents.filter(a => a.status === 'offline'),

  // Actions
  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      const response = await api.get('/agents');
      set({
        agents: response.data.agents || [],
        loading: false,
        lastUpdate: new Date().toISOString(),
      });
    } catch (error) {
      set({ error: error.message, loading: false });
    }
  },

  fetchAgent: async (nodeId) => {
    set({ loading: true, error: null });
    try {
      const response = await api.get(`/agents/${nodeId}`);
      set({ selectedAgent: response.data, loading: false });
      return response.data;
    } catch (error) {
      set({ error: error.message, loading: false });
      return null;
    }
  },

  updateAgentMetrics: (nodeId, metrics) => {
    set(state => ({
      agents: state.agents.map(agent =>
        agent.node_id === nodeId
          ? {
              ...agent,
              status: 'online',
              last_heartbeat: metrics.timestamp,
              system: metrics.system,
              gpus: metrics.gpus,
              containers: metrics.containers,
            }
          : agent
      ),
      lastUpdate: new Date().toISOString(),
    }));
  },

  setAgentOffline: (nodeId) => {
    set(state => ({
      agents: state.agents.map(agent =>
        agent.node_id === nodeId
          ? { ...agent, status: 'offline' }
          : agent
      ),
    }));
  },

  selectAgent: (nodeId) => {
    const agent = get().agents.find(a => a.node_id === nodeId);
    set({ selectedAgent: agent });
  },

  clearSelection: () => {
    set({ selectedAgent: null });
  },

  // Send command to agent
  sendCommand: async (nodeId, command) => {
    try {
      const response = await api.post(`/agents/${nodeId}/command`, command);
      return response.data;
    } catch (error) {
      set({ error: error.message });
      throw error;
    }
  },
}));

export default useAgentStore;
