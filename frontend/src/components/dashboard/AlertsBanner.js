import React, { useEffect } from 'react';
import { useAlertStore } from '../../stores';
import { AlertTriangle, AlertCircle, Info, X, Check } from 'lucide-react';

const SEVERITY_CONFIG = {
  critical: { icon: AlertTriangle, bg: 'bg-red-500/20', border: 'border-red-500', text: 'text-red-400' },
  error: { icon: AlertCircle, bg: 'bg-orange-500/20', border: 'border-orange-500', text: 'text-orange-400' },
  warning: { icon: AlertTriangle, bg: 'bg-yellow-500/20', border: 'border-yellow-500', text: 'text-yellow-400' },
  info: { icon: Info, bg: 'bg-blue-500/20', border: 'border-blue-500', text: 'text-blue-400' },
};

/**
 * Alerts Banner - Displays active alerts at the top of the dashboard
 */
function AlertsBanner() {
  const { activeAlerts, fetchActiveAlerts, acknowledgeAlert, resolveAlert } = useAlertStore();

  useEffect(() => {
    fetchActiveAlerts();
    const interval = setInterval(fetchActiveAlerts, 30000);
    return () => clearInterval(interval);
  }, [fetchActiveAlerts]);

  if (activeAlerts.length === 0) {
    return null;
  }

  // Group by severity and take top alerts
  const sortedAlerts = [...activeAlerts].sort((a, b) => {
    const order = { critical: 0, error: 1, warning: 2, info: 3 };
    return (order[a.severity] || 4) - (order[b.severity] || 4);
  }).slice(0, 5);

  const handleAcknowledge = async (e, alertId) => {
    e.stopPropagation();
    await acknowledgeAlert(alertId, 'user');
  };

  const handleResolve = async (e, alertId) => {
    e.stopPropagation();
    await resolveAlert(alertId);
  };

  return (
    <div className="space-y-2 mb-4">
      {sortedAlerts.map(alert => {
        const config = SEVERITY_CONFIG[alert.severity] || SEVERITY_CONFIG.info;
        const Icon = config.icon;

        return (
          <div
            key={alert.id}
            className={`flex items-center gap-3 p-3 rounded-lg border ${config.bg} ${config.border}`}
          >
            <Icon className={`w-5 h-5 ${config.text} flex-shrink-0`} />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`font-medium ${config.text}`}>{alert.title}</span>
                {alert.node_id && (
                  <span className="text-xs text-gray-400 bg-gray-700 px-2 py-0.5 rounded">
                    {alert.node_id}
                  </span>
                )}
                {alert.status === 'acknowledged' && (
                  <span className="text-xs text-gray-400">
                    (acknowledged)
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-400 truncate">{alert.message}</p>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {alert.status === 'active' && (
                <button
                  onClick={(e) => handleAcknowledge(e, alert.id)}
                  className="p-1.5 hover:bg-gray-700 rounded transition-colors"
                  title="Acknowledge"
                >
                  <Check className="w-4 h-4 text-gray-400" />
                </button>
              )}
              <button
                onClick={(e) => handleResolve(e, alert.id)}
                className="p-1.5 hover:bg-gray-700 rounded transition-colors"
                title="Resolve"
              >
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
          </div>
        );
      })}

      {activeAlerts.length > 5 && (
        <div className="text-center text-sm text-gray-400">
          + {activeAlerts.length - 5} more alerts
        </div>
      )}
    </div>
  );
}

export default AlertsBanner;
