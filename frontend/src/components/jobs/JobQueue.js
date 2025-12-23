import React, { useEffect } from 'react';
import { useJobStore } from '../../stores';
import { Clock, PlayCircle, CheckCircle, XCircle, RefreshCw, Trash2, Image } from 'lucide-react';

const PRIORITY_COLORS = {
  high: 'text-red-400 bg-red-500/20',
  normal: 'text-yellow-400 bg-yellow-500/20',
  low: 'text-gray-400 bg-gray-500/20',
};

const JOB_TYPE_ICONS = {
  image_gen: Image,
  video_gen: PlayCircle,
  default: Clock,
};

/**
 * Job Queue - List view of all jobs with actions
 */
function JobQueue({ onJobClick }) {
  const { jobs, pendingJobs, runningJobs, loading, fetchJobs, cancelJob, retryJob } = useJobStore();

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 10000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const handleCancel = async (e, jobId) => {
    e.stopPropagation();
    if (window.confirm('Cancel this job?')) {
      await cancelJob(jobId);
    }
  };

  const handleRetry = async (e, jobId) => {
    e.stopPropagation();
    await retryJob(jobId);
  };

  const formatDate = (date) => {
    if (!date) return '-';
    return new Date(date).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const JobRow = ({ job }) => {
    const TypeIcon = JOB_TYPE_ICONS[job.job_type] || JOB_TYPE_ICONS.default;
    const isRunning = job.status === 'running';
    const isPending = job.status === 'pending';
    const isFailed = job.status === 'failed';
    const isCompleted = job.status === 'completed';

    return (
      <div
        className="flex items-center gap-4 p-3 bg-gray-700/50 rounded-lg cursor-pointer hover:bg-gray-700 transition-colors"
        onClick={() => onJobClick?.(job)}
      >
        {/* Type icon */}
        <div className={`p-2 rounded-lg ${
          isRunning ? 'bg-blue-500/20' :
          isCompleted ? 'bg-green-500/20' :
          isFailed ? 'bg-red-500/20' : 'bg-gray-600'
        }`}>
          <TypeIcon className={`w-5 h-5 ${
            isRunning ? 'text-blue-400 animate-pulse' :
            isCompleted ? 'text-green-400' :
            isFailed ? 'text-red-400' : 'text-gray-400'
          }`} />
        </div>

        {/* Job info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-white truncate">
              {job.payload?.prompt?.slice(0, 40) || job.job_type || 'Job'}
              {job.payload?.prompt?.length > 40 && '...'}
            </span>
            <span className={`px-2 py-0.5 rounded text-xs ${PRIORITY_COLORS[job.priority] || PRIORITY_COLORS.normal}`}>
              {job.priority || 'normal'}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-400 mt-1">
            <span>{job.id?.slice(0, 8)}</span>
            {job.node_id && <span>on {job.node_id}</span>}
            <span>{formatDate(job.created_at)}</span>
          </div>
        </div>

        {/* Progress (for running jobs) */}
        {isRunning && job.progress !== undefined && (
          <div className="w-24">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-gray-400">Progress</span>
              <span className="text-blue-400">{job.progress}%</span>
            </div>
            <div className="h-1.5 bg-gray-600 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${job.progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Status badge */}
        <div className={`px-3 py-1 rounded-full text-xs font-medium ${
          isRunning ? 'bg-blue-500/20 text-blue-400' :
          isCompleted ? 'bg-green-500/20 text-green-400' :
          isFailed ? 'bg-red-500/20 text-red-400' :
          'bg-yellow-500/20 text-yellow-400'
        }`}>
          {job.status}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {isFailed && (
            <button
              onClick={(e) => handleRetry(e, job.id)}
              className="p-1.5 hover:bg-gray-600 rounded transition-colors"
              title="Retry job"
            >
              <RefreshCw className="w-4 h-4 text-yellow-400" />
            </button>
          )}
          {(isPending || isRunning) && (
            <button
              onClick={(e) => handleCancel(e, job.id)}
              className="p-1.5 hover:bg-gray-600 rounded transition-colors"
              title="Cancel job"
            >
              <Trash2 className="w-4 h-4 text-red-400" />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Job Queue</h3>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">
            {pendingJobs.length} pending, {runningJobs.length} running
          </span>
          <button
            onClick={() => fetchJobs()}
            className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 text-gray-400 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Job list */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {jobs.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            No jobs in queue
          </div>
        ) : (
          jobs.map(job => <JobRow key={job.id} job={job} />)
        )}
      </div>
    </div>
  );
}

export default JobQueue;
