import { create } from 'zustand';
import api from '../api';

/**
 * Alert Store - Manages system alerts and notifications
 */
const useAlertStore = create((set, get) => ({
  // State
  alerts: [],
  activeAlerts: [],
  alertHistory: [],
  unacknowledgedCount: 0,
  loading: false,
  error: null,

  // Get alerts by severity
  getCriticalAlerts: () => get().activeAlerts.filter(a => a.severity === 'critical'),
  getErrorAlerts: () => get().activeAlerts.filter(a => a.severity === 'error'),
  getWarningAlerts: () => get().activeAlerts.filter(a => a.severity === 'warning'),

  // Get alerts for a specific node
  getNodeAlerts: (nodeId) => get().activeAlerts.filter(a => a.node_id === nodeId),

  // Actions
  fetchActiveAlerts: async () => {
    set({ loading: true, error: null });
    try {
      const response = await api.get('/alerts/active');
      const alerts = response.data.alerts || [];
      set({
        activeAlerts: alerts,
        unacknowledgedCount: alerts.filter(a => a.status === 'active').length,
        loading: false,
      });
    } catch (error) {
      set({ error: error.message, loading: false });
    }
  },

  fetchAlertHistory: async (limit = 100) => {
    set({ loading: true, error: null });
    try {
      const response = await api.get('/alerts', { params: { limit } });
      set({
        alertHistory: response.data.alerts || [],
        loading: false,
      });
    } catch (error) {
      set({ error: error.message, loading: false });
    }
  },

  addAlert: (alert) => {
    set(state => {
      // Avoid duplicates
      if (state.activeAlerts.find(a => a.id === alert.id)) {
        return state;
      }
      return {
        activeAlerts: [alert, ...state.activeAlerts],
        unacknowledgedCount: state.unacknowledgedCount + 1,
      };
    });
  },

  acknowledgeAlert: async (alertId, acknowledgedBy = 'user') => {
    try {
      await api.post(`/alerts/${alertId}/acknowledge`, { acknowledged_by: acknowledgedBy });
      set(state => ({
        activeAlerts: state.activeAlerts.map(alert =>
          alert.id === alertId
            ? { ...alert, status: 'acknowledged', acknowledged_by: acknowledgedBy }
            : alert
        ),
        unacknowledgedCount: Math.max(0, state.unacknowledgedCount - 1),
      }));
    } catch (error) {
      set({ error: error.message });
      throw error;
    }
  },

  resolveAlert: async (alertId) => {
    try {
      await api.post(`/alerts/${alertId}/resolve`);
      set(state => ({
        activeAlerts: state.activeAlerts.filter(a => a.id !== alertId),
        unacknowledgedCount: state.activeAlerts.find(a => a.id === alertId)?.status === 'active'
          ? Math.max(0, state.unacknowledgedCount - 1)
          : state.unacknowledgedCount,
      }));
    } catch (error) {
      set({ error: error.message });
      throw error;
    }
  },

  updateAlert: (alertId, updates) => {
    set(state => ({
      activeAlerts: state.activeAlerts.map(alert =>
        alert.id === alertId ? { ...alert, ...updates } : alert
      ),
    }));
  },

  removeAlert: (alertId) => {
    set(state => ({
      activeAlerts: state.activeAlerts.filter(a => a.id !== alertId),
    }));
  },

  clearError: () => set({ error: null }),
}));

export default useAlertStore;
