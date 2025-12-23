import React, { useMemo } from 'react';
import { useJobStore } from '../../stores';
import { Clock, CheckCircle, XCircle, Loader, AlertCircle } from 'lucide-react';

const STATUS_CONFIG = {
  pending: { color: 'bg-yellow-500', icon: Clock, text: 'Pending' },
  running: { color: 'bg-blue-500', icon: Loader, text: 'Running' },
  completed: { color: 'bg-green-500', icon: CheckCircle, text: 'Completed' },
  failed: { color: 'bg-red-500', icon: XCircle, text: 'Failed' },
  cancelled: { color: 'bg-gray-500', icon: AlertCircle, text: 'Cancelled' },
};

/**
 * Job Timeline - Gantt-style visualization of jobs
 */
function JobTimeline({ onJobClick, maxJobs = 20 }) {
  const jobs = useJobStore(state => state.jobs);
  const runningJobs = useJobStore(state => state.runningJobs);
  const pendingJobs = useJobStore(state => state.pendingJobs);

  // Sort jobs by created_at, most recent first
  const sortedJobs = useMemo(() => {
    return [...jobs]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, maxJobs);
  }, [jobs, maxJobs]);

  // Calculate time range for the timeline
  const timeRange = useMemo(() => {
    if (sortedJobs.length === 0) return { start: Date.now() - 3600000, end: Date.now() };

    const times = sortedJobs.flatMap(job => [
      new Date(job.created_at).getTime(),
      job.completed_at ? new Date(job.completed_at).getTime() : Date.now(),
    ]);

    return {
      start: Math.min(...times),
      end: Math.max(...times, Date.now()),
    };
  }, [sortedJobs]);

  const getJobPosition = (job) => {
    const duration = timeRange.end - timeRange.start;
    const startTime = new Date(job.created_at).getTime();
    const endTime = job.completed_at ? new Date(job.completed_at).getTime() : Date.now();

    const left = ((startTime - timeRange.start) / duration) * 100;
    const width = ((endTime - startTime) / duration) * 100;

    return { left: `${Math.max(0, left)}%`, width: `${Math.max(2, width)}%` };
  };

  const formatTime = (date) => {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDuration = (job) => {
    if (!job.created_at) return '-';
    const start = new Date(job.created_at).getTime();
    const end = job.completed_at ? new Date(job.completed_at).getTime() : Date.now();
    const seconds = Math.floor((end - start) / 1000);

    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Job Timeline</h3>
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1 text-blue-400">
            <Loader className="w-4 h-4 animate-spin" />
            {runningJobs.length} Running
          </span>
          <span className="flex items-center gap-1 text-yellow-400">
            <Clock className="w-4 h-4" />
            {pendingJobs.length} Queued
          </span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mb-4 text-xs">
        {Object.entries(STATUS_CONFIG).map(([status, config]) => (
          <div key={status} className="flex items-center gap-1">
            <div className={`w-3 h-3 rounded ${config.color}`} />
            <span className="text-gray-400">{config.text}</span>
          </div>
        ))}
      </div>

      {/* Timeline header with time markers */}
      <div className="relative h-8 mb-2 border-b border-gray-700">
        <span className="absolute left-0 text-xs text-gray-500">
          {formatTime(timeRange.start)}
        </span>
        <span className="absolute right-0 text-xs text-gray-500">
          {formatTime(timeRange.end)}
        </span>
        {/* Time markers */}
        {[0.25, 0.5, 0.75].map(pos => (
          <span
            key={pos}
            className="absolute text-xs text-gray-600"
            style={{ left: `${pos * 100}%`, transform: 'translateX(-50%)' }}
          >
            {formatTime(timeRange.start + (timeRange.end - timeRange.start) * pos)}
          </span>
        ))}
      </div>

      {/* Job rows */}
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {sortedJobs.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            No jobs in timeline
          </div>
        ) : (
          sortedJobs.map(job => {
            const config = STATUS_CONFIG[job.status] || STATUS_CONFIG.pending;
            const Icon = config.icon;
            const position = getJobPosition(job);

            return (
              <div
                key={job.id}
                className="relative h-10 cursor-pointer hover:bg-gray-700/50 rounded transition-colors"
                onClick={() => onJobClick?.(job)}
              >
                {/* Job label */}
                <div className="absolute left-0 top-0 h-full flex items-center z-10 pr-2">
                  <span className="text-xs text-gray-400 w-24 truncate">
                    {job.job_type || 'job'}
                  </span>
                </div>

                {/* Timeline bar container */}
                <div className="absolute left-28 right-0 top-0 h-full">
                  {/* Background track */}
                  <div className="absolute inset-0 bg-gray-700/30 rounded" />

                  {/* Job bar */}
                  <div
                    className={`absolute top-1 bottom-1 ${config.color} rounded flex items-center px-2 transition-all`}
                    style={position}
                  >
                    <Icon className={`w-3 h-3 text-white ${job.status === 'running' ? 'animate-spin' : ''}`} />
                    {job.progress !== undefined && job.status === 'running' && (
                      <span className="ml-1 text-xs text-white font-medium">
                        {job.progress}%
                      </span>
                    )}
                  </div>

                  {/* Progress overlay for running jobs */}
                  {job.status === 'running' && job.progress !== undefined && (
                    <div
                      className="absolute top-1 bottom-1 bg-blue-400/30 rounded"
                      style={{
                        left: position.left,
                        width: `calc(${position.width} * ${job.progress / 100})`,
                      }}
                    />
                  )}
                </div>

                {/* Duration label */}
                <div className="absolute right-2 top-0 h-full flex items-center">
                  <span className="text-xs text-gray-500">
                    {formatDuration(job)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Summary footer */}
      {sortedJobs.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-700 flex items-center justify-between text-sm text-gray-400">
          <span>Showing {sortedJobs.length} of {jobs.length} jobs</span>
          <div className="flex items-center gap-4">
            <span className="text-green-400">
              {jobs.filter(j => j.status === 'completed').length} completed
            </span>
            <span className="text-red-400">
              {jobs.filter(j => j.status === 'failed').length} failed
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default JobTimeline;
