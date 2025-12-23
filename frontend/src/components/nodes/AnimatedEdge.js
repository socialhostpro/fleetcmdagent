import React from 'react';
import { getBezierPath } from 'reactflow';

const AnimatedEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  data,
  markerEnd,
}) => {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const isActive = data?.active || false;
  const trafficLevel = data?.traffic || 0; // 0-100

  // Calculate animation speed based on traffic level
  const animationDuration = trafficLevel > 50 ? '0.5s' : trafficLevel > 20 ? '1s' : '2s';

  return (
    <>
      {/* Background edge */}
      <path
        id={id}
        style={{
          ...style,
          strokeWidth: 2,
          stroke: '#2a2a3a',
        }}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
      />

      {/* Animated overlay when active */}
      {isActive && (
        <path
          style={{
            strokeWidth: 3,
            stroke: '#00d4ff',
            strokeDasharray: 6,
            animation: `flowAnimation ${animationDuration} linear infinite`,
            filter: 'drop-shadow(0 0 3px rgba(0, 212, 255, 0.5))',
          }}
          className="react-flow__edge-path"
          d={edgePath}
        />
      )}

      {/* Flowing particles for high traffic */}
      {isActive && trafficLevel > 30 && (
        <>
          <circle r="3" fill="#00d4ff" filter="url(#glow)">
            <animateMotion dur={animationDuration} repeatCount="indefinite">
              <mpath href={`#${id}`} />
            </animateMotion>
          </circle>
          {trafficLevel > 60 && (
            <circle r="3" fill="#00d4ff" filter="url(#glow)">
              <animateMotion dur={animationDuration} repeatCount="indefinite" begin="0.3s">
                <mpath href={`#${id}`} />
              </animateMotion>
            </circle>
          )}
        </>
      )}
    </>
  );
};

export default AnimatedEdge;
