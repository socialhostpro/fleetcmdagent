import React, { useCallback, useMemo, useEffect, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useAgentStore, useMetricsStore } from '../../stores';
import NodeCard from './NodeCard';
import ClusterGroup from './ClusterGroup';

// Custom node types
const nodeTypes = {
  agentNode: NodeCard,
  clusterGroup: ClusterGroup,
};

// Cluster colors
const CLUSTER_COLORS = {
  vision: { bg: 'rgba(59, 130, 246, 0.1)', border: '#3b82f6' },
  llm: { bg: 'rgba(168, 85, 247, 0.1)', border: '#a855f7' },
  storage: { bg: 'rgba(34, 197, 94, 0.1)', border: '#22c55e' },
  default: { bg: 'rgba(107, 114, 128, 0.1)', border: '#6b7280' },
};

/**
 * Node Topology Map - Visual representation of the fleet
 */
function NodeTopologyMap({ onNodeClick }) {
  const agents = useAgentStore(state => state.agents);
  const clusterMetrics = useMetricsStore(state => state.clusterMetrics);
  const fetchAgents = useAgentStore(state => state.fetchAgents);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Fetch agents on mount
  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [fetchAgents]);

  // Build nodes and edges from agents
  useEffect(() => {
    if (!agents.length) return;

    // Group agents by cluster
    const clusters = {};
    agents.forEach(agent => {
      const cluster = agent.cluster || 'default';
      if (!clusters[cluster]) {
        clusters[cluster] = [];
      }
      clusters[cluster].push(agent);
    });

    const newNodes = [];
    const newEdges = [];
    let yOffset = 0;

    // Create cluster groups and nodes
    Object.entries(clusters).forEach(([clusterName, clusterAgents], clusterIndex) => {
      const clusterColor = CLUSTER_COLORS[clusterName] || CLUSTER_COLORS.default;
      const nodesPerRow = 3;
      const nodeWidth = 280;
      const nodeHeight = 180;
      const padding = 40;
      const rows = Math.ceil(clusterAgents.length / nodesPerRow);

      // Cluster group node
      newNodes.push({
        id: `cluster-${clusterName}`,
        type: 'clusterGroup',
        position: { x: 50, y: yOffset },
        data: {
          name: clusterName,
          nodeCount: clusterAgents.length,
          onlineCount: clusterAgents.filter(a => a.status === 'online').length,
          color: clusterColor,
          metrics: clusterMetrics[clusterName],
        },
        style: {
          width: nodesPerRow * (nodeWidth + padding) + padding,
          height: rows * (nodeHeight + padding) + 80,
          backgroundColor: clusterColor.bg,
          border: `2px dashed ${clusterColor.border}`,
          borderRadius: '12px',
          padding: '20px',
        },
        draggable: false,
      });

      // Agent nodes within cluster
      clusterAgents.forEach((agent, index) => {
        const row = Math.floor(index / nodesPerRow);
        const col = index % nodesPerRow;

        newNodes.push({
          id: agent.node_id,
          type: 'agentNode',
          position: {
            x: 70 + col * (nodeWidth + padding),
            y: yOffset + 60 + row * (nodeHeight + padding),
          },
          data: {
            agent,
            onClick: () => onNodeClick?.(agent),
          },
          parentNode: `cluster-${clusterName}`,
          extent: 'parent',
        });

        // Edge from cluster center to each node
        newEdges.push({
          id: `edge-${clusterName}-${agent.node_id}`,
          source: `cluster-${clusterName}`,
          target: agent.node_id,
          type: 'smoothstep',
          animated: agent.status === 'online',
          style: {
            stroke: agent.status === 'online' ? clusterColor.border : '#6b7280',
            strokeWidth: 2,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: agent.status === 'online' ? clusterColor.border : '#6b7280',
          },
        });
      });

      yOffset += rows * (nodeHeight + padding) + 120;
    });

    setNodes(newNodes);
    setEdges(newEdges);
  }, [agents, clusterMetrics, onNodeClick, setNodes, setEdges]);

  const onNodeClickHandler = useCallback((event, node) => {
    if (node.type === 'agentNode' && node.data?.agent) {
      onNodeClick?.(node.data.agent);
    }
  }, [onNodeClick]);

  return (
    <div className="w-full h-full bg-gray-900 rounded-lg overflow-hidden">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClickHandler}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.3}
        maxZoom={1.5}
        defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
      >
        <Background color="#374151" gap={20} />
        <Controls className="bg-gray-800 border-gray-700" />
        <MiniMap
          nodeColor={(node) => {
            if (node.type === 'clusterGroup') return 'transparent';
            return node.data?.agent?.status === 'online' ? '#22c55e' : '#ef4444';
          }}
          maskColor="rgba(0, 0, 0, 0.8)"
          className="bg-gray-800 border-gray-700"
        />
      </ReactFlow>
    </div>
  );
}

export default NodeTopologyMap;
