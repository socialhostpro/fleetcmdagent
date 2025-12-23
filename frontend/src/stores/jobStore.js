import { create } from 'zustand';
import api from '../api';

/**
 * Job Store - Manages job queue state
 */
const useJobStore = create((set, get) => ({
  // State
  jobs: [],
  pendingJobs: [],
  runningJobs: [],
  completedJobs: [],
  failedJobs: [],
  selectedJob: null,
  queueStats: null,
  loading: false,
  error: null,

  // Computed
  getJobById: (jobId) => get().jobs.find(j => j.id === jobId),
  getJobsByNode: (nodeId) => get().jobs.filter(j => j.node_id === nodeId),
  getJobsByStatus: (status) => get().jobs.filter(j => j.status === status),

  // Actions
  fetchJobs: async (limit = 100) => {
    set({ loading: true, error: null });
    try {
      const response = await api.get('/queue/jobs', { params: { limit } });
      const jobs = response.data.jobs || [];

      set({
        jobs,
        pendingJobs: jobs.filter(j => j.status === 'pending'),
        runningJobs: jobs.filter(j => j.status === 'running'),
        completedJobs: jobs.filter(j => j.status === 'completed'),
        failedJobs: jobs.filter(j => j.status === 'failed'),
        loading: false,
      });
    } catch (error) {
      set({ error: error.message, loading: false });
    }
  },

  fetchQueueStats: async () => {
    try {
      const response = await api.get('/queue/stats');
      set({ queueStats: response.data });
    } catch (error) {
      set({ error: error.message });
    }
  },

  addJob: (job) => {
    set(state => {
      // Avoid duplicates
      if (state.jobs.find(j => j.id === job.id)) {
        return state;
      }
      const newJobs = [job, ...state.jobs];
      return {
        jobs: newJobs,
        pendingJobs: newJobs.filter(j => j.status === 'pending'),
        runningJobs: newJobs.filter(j => j.status === 'running'),
        completedJobs: newJobs.filter(j => j.status === 'completed'),
        failedJobs: newJobs.filter(j => j.status === 'failed'),
      };
    });
  },

  updateJob: (jobId, updates) => {
    set(state => {
      const updatedJobs = state.jobs.map(job =>
        job.id === jobId ? { ...job, ...updates } : job
      );
      return {
        jobs: updatedJobs,
        pendingJobs: updatedJobs.filter(j => j.status === 'pending'),
        runningJobs: updatedJobs.filter(j => j.status === 'running'),
        completedJobs: updatedJobs.filter(j => j.status === 'completed'),
        failedJobs: updatedJobs.filter(j => j.status === 'failed'),
        selectedJob: state.selectedJob?.id === jobId
          ? { ...state.selectedJob, ...updates }
          : state.selectedJob,
      };
    });
  },

  removeJob: (jobId) => {
    set(state => {
      const filteredJobs = state.jobs.filter(j => j.id !== jobId);
      return {
        jobs: filteredJobs,
        pendingJobs: filteredJobs.filter(j => j.status === 'pending'),
        runningJobs: filteredJobs.filter(j => j.status === 'running'),
        completedJobs: filteredJobs.filter(j => j.status === 'completed'),
        failedJobs: filteredJobs.filter(j => j.status === 'failed'),
      };
    });
  },

  selectJob: (jobId) => {
    const job = get().jobs.find(j => j.id === jobId);
    set({ selectedJob: job });
  },

  clearSelection: () => set({ selectedJob: null }),

  cancelJob: async (jobId) => {
    try {
      await api.delete(`/queue/jobs/${jobId}`);
      get().removeJob(jobId);
    } catch (error) {
      set({ error: error.message });
      throw error;
    }
  },

  retryJob: async (jobId) => {
    try {
      const response = await api.post(`/queue/jobs/${jobId}/retry`);
      get().updateJob(jobId, { status: 'pending', retries: (response.data.retries || 0) + 1 });
    } catch (error) {
      set({ error: error.message });
      throw error;
    }
  },

  // Submit a new job
  submitJob: async (jobData) => {
    try {
      const response = await api.post('/queue/jobs', jobData);
      get().addJob(response.data);
      return response.data;
    } catch (error) {
      set({ error: error.message });
      throw error;
    }
  },
}));

export default useJobStore;
