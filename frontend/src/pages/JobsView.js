import React, { useEffect, useState } from 'react';
import { useJobStore } from '../stores';
import { useFleetWebSocket } from '../hooks/useFleetWebSocket';
import { JobTimeline, JobQueue } from '../components/jobs';
import {
  RefreshCw, Plus, Wifi, WifiOff, Clock, CheckCircle, XCircle, Loader
} from 'lucide-react';

/**
 * Jobs View - Job queue management and timeline
 */
function JobsView() {
  const { connected } = useFleetWebSocket();
  const { jobs, pendingJobs, runningJobs, completedJobs, failedJobs, loading, fetchJobs, fetchQueueStats, queueStats, submitJob } = useJobStore();
  const [selectedJob, setSelectedJob] = useState(null);
  const [showNewJobModal, setShowNewJobModal] = useState(false);
  const [newJobPrompt, setNewJobPrompt] = useState('');
  const [newJobPriority, setNewJobPriority] = useState('normal');

  useEffect(() => {
    fetchJobs();
    fetchQueueStats();
    const interval = setInterval(() => {
      fetchJobs();
      fetchQueueStats();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchJobs, fetchQueueStats]);

  const handleSubmitJob = async () => {
    if (!newJobPrompt.trim()) return;
    try {
      await submitJob({
        job_type: 'image_gen',
        priority: newJobPriority,
        payload: { prompt: newJobPrompt },
      });
      setNewJobPrompt('');
      setShowNewJobModal(false);
    } catch (error) {
      console.error('Failed to submit job:', error);
    }
  };

  const StatCard = ({ icon: Icon, label, value, color }) => (
    <div className="bg-gray-800 rounded-lg p-4 flex items-center gap-4">
      <div className={`p-3 rounded-lg ${color}`}>
        <Icon className="w-6 h-6 text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-sm text-gray-400">{label}</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Job Queue</h1>
          <p className="text-gray-400 text-sm">
            {jobs.length} total jobs
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
            connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
            {connected ? 'Live' : 'Offline'}
          </div>
          <button
            onClick={() => setShowNewJobModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Job
          </button>
          <button
            onClick={() => { fetchJobs(); fetchQueueStats(); }}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard icon={Clock} label="Pending" value={pendingJobs.length} color="bg-yellow-500" />
        <StatCard icon={Loader} label="Running" value={runningJobs.length} color="bg-blue-500" />
        <StatCard icon={CheckCircle} label="Completed" value={completedJobs.length} color="bg-green-500" />
        <StatCard icon={XCircle} label="Failed" value={failedJobs.length} color="bg-red-500" />
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <JobTimeline onJobClick={setSelectedJob} maxJobs={20} />
        <JobQueue onJobClick={setSelectedJob} />
      </div>

      {/* Queue Stats */}
      {queueStats && (
        <div className="mt-6 bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold mb-4">Queue Statistics</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-gray-400">Total Processed</p>
              <p className="text-xl font-bold">{queueStats.total_processed || 0}</p>
            </div>
            <div>
              <p className="text-gray-400">Success Rate</p>
              <p className="text-xl font-bold text-green-400">
                {queueStats.success_rate?.toFixed(1) || 0}%
              </p>
            </div>
            <div>
              <p className="text-gray-400">Avg Processing Time</p>
              <p className="text-xl font-bold">
                {queueStats.avg_processing_time?.toFixed(1) || 0}s
              </p>
            </div>
            <div>
              <p className="text-gray-400">Queue Throughput</p>
              <p className="text-xl font-bold">
                {queueStats.throughput_per_hour?.toFixed(0) || 0}/hr
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Job Details Modal */}
      {selectedJob && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setSelectedJob(null)}
        >
          <div
            className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold">Job Details</h3>
              <button
                onClick={() => setSelectedJob(null)}
                className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
              >
                &times;
              </button>
            </div>
            <pre className="bg-gray-900 rounded-lg p-4 text-sm overflow-auto">
              {JSON.stringify(selectedJob, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* New Job Modal */}
      {showNewJobModal && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setShowNewJobModal(false)}
        >
          <div
            className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-xl font-bold mb-4">Create New Job</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Prompt</label>
                <textarea
                  value={newJobPrompt}
                  onChange={(e) => setNewJobPrompt(e.target.value)}
                  placeholder="Enter your image generation prompt..."
                  rows={3}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Priority</label>
                <select
                  value={newJobPriority}
                  onChange={(e) => setNewJobPriority(e.target.value)}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowNewJobModal(false)}
                  className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmitJob}
                  disabled={!newJobPrompt.trim()}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors disabled:opacity-50"
                >
                  Submit Job
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default JobsView;
