import SparkNode from './SparkNode';
import XavierNode from './XavierNode';
import RoamerNode from './RoamerNode';
import MetricBar from './MetricBar';
import StatusDot from './StatusDot';

// Re-export components
export { SparkNode, XavierNode, RoamerNode, MetricBar, StatusDot };

// Node types for React Flow
export const nodeTypes = {
  spark: SparkNode,
  xavier: XavierNode,
  roamer: RoamerNode,
};
