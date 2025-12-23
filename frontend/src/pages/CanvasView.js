import React, { useCallback, useEffect, useState, useRef } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Panel,
  MarkerType,
  useReactFlow,
  ReactFlowProvider,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useMetricsWebSocket } from '../hooks/useWebSocket';
import { nodeTypes } from '../components/nodes';
import AnimatedEdge from '../components/nodes/AnimatedEdge';
import {
  Wifi, WifiOff, RefreshCw, Maximize2, Layers, Plus, Trash2,
  Link2, Unlink, LayoutGrid, Save, FolderOpen, Container, Network, HardDrive
} from 'lucide-react';
import DiskCleanupModal from '../components/DiskCleanupModal';
import clsx from 'clsx';

const API_URL = `http://${window.location.hostname}:8765/api`;

// Custom edge types
const edgeTypes = {
  animated: AnimatedEdge,
};

// Determine node type based on node_id or metadata
// Handles formats: agx0, agx-0, agx-01, agx01
const getNodeType = (nodeData) => {
  const id = nodeData.node_id?.toLowerCase() || '';
  if (id.includes('spark') || id.includes('dgx')) return 'spark';
  // Handle both agx-11 and agx11 formats for roamers (high numbered AGX)
  const match = id.match(/agx-?(\d+)/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num >= 11 && num <= 15 && nodeData.is_idle) return 'roamer';
  }
  if (id.includes('roamer')) return 'roamer';
  // Any AGX node defaults to xavier
  if (id.includes('agx')) return 'xavier';
  return 'xavier';
};

// Get cluster from node data - uses actual cluster label from Swarm, falls back to ID-based pattern
const getCluster = (nodeData) => {
  // If nodeData is a string (backwards compatibility), treat as node_id
  const nodeId = typeof nodeData === 'string' ? nodeData : nodeData?.node_id;
  const actualCluster = typeof nodeData === 'object' ? nodeData?.cluster : null;

  // Use actual cluster label from Swarm if available
  if (actualCluster) {
    return actualCluster;
  }

  // Fallback to ID-based pattern for nodes not yet in Swarm
  const id = nodeId?.toLowerCase() || '';
  if (id.includes('spark') || id.includes('dgx')) return 'spark';

  // Extract node number - handles agx0, agx-0, agx-01, agx01
  const match = id.match(/agx-?(\d+)/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (num >= 0 && num <= 2) return 'vision';
    if (num >= 3 && num <= 4) return 'media-gen';
    if (num >= 5 && num <= 6) return 'media-proc';
    if (num >= 7 && num <= 9) return 'llm';
    if (num === 10) return 'voice';
    if (num === 11) return 'music';
    if (num >= 12 && num <= 15) return 'roamer';
  }
  return 'unassigned';
};

// Layout constants - prevent overlap
const NODE_WIDTH = 240;    // Node width including padding
const NODE_HEIGHT = 280;   // Max node height with all sections expanded
const NODE_SPACING_X = 40; // Horizontal gap between nodes
const NODE_SPACING_Y = 60; // Vertical gap between rows
const MAX_NODES_PER_ROW = 4; // Max nodes per row before wrapping

// Layout nodes in a logical arrangement - prevents overlapping
const calculateLayout = (nodes, savedPositions = {}) => {
  const layout = [];
  const sparkNode = nodes.find(n => getNodeType(n) === 'spark');
  const workerNodes = nodes.filter(n => getNodeType(n) !== 'spark');

  // Spark node at top center
  if (sparkNode) {
    layout.push({
      ...sparkNode,
      position: savedPositions[sparkNode.node_id] || { x: 500, y: 30 },
    });
  }

  // Arrange workers in rows by cluster - use full node data for actual cluster labels
  const clusters = {};
  workerNodes.forEach(node => {
    const cluster = getCluster(node);
    if (!clusters[cluster]) clusters[cluster] = [];
    clusters[cluster].push(node);
  });

  // Sort clusters for consistent ordering
  const clusterOrder = ['vision', 'media-gen', 'media-proc', 'inference', 'llm', 'voice', 'music', 'roamer', 'unassigned'];
  const sortedClusters = Object.entries(clusters).sort((a, b) => {
    const aIdx = clusterOrder.indexOf(a[0]);
    const bIdx = clusterOrder.indexOf(b[0]);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  let rowY = 200; // Start below spark node

  sortedClusters.forEach(([cluster, clusterNodes]) => {
    // Calculate how many rows needed for this cluster
    const nodesPerRow = Math.min(clusterNodes.length, MAX_NODES_PER_ROW);
    const totalRowWidth = nodesPerRow * (NODE_WIDTH + NODE_SPACING_X) - NODE_SPACING_X;
    const startX = Math.max(50, (1200 - totalRowWidth) / 2); // Center on 1200px canvas

    clusterNodes.forEach((node, i) => {
      const col = i % MAX_NODES_PER_ROW;
      const row = Math.floor(i / MAX_NODES_PER_ROW);

      const x = startX + col * (NODE_WIDTH + NODE_SPACING_X);
      const y = rowY + row * (NODE_HEIGHT + NODE_SPACING_Y);

      layout.push({
        ...node,
        position: savedPositions[node.node_id] || { x, y },
      });
    });

    // Move Y position for next cluster (account for multiple rows in this cluster)
    const rowsInCluster = Math.ceil(clusterNodes.length / MAX_NODES_PER_ROW);
    rowY += rowsInCluster * (NODE_HEIGHT + NODE_SPACING_Y) + 40; // Extra gap between clusters
  });

  return layout;
};

// Local storage keys
const POSITIONS_KEY = 'fleet-commander-node-positions';
const EDGES_KEY = 'fleet-commander-edges';

const CanvasViewInner = ({ onNodeSelect }) => {
  const { nodes: wsNodes, isConnected, lastUpdate, reconnect } = useMetricsWebSocket();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [selectedNodes, setSelectedNodes] = useState([]);
  const [selectedEdges, setSelectedEdges] = useState([]);
  const [showClusterModal, setShowClusterModal] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [diskCleanupNode, setDiskCleanupNode] = useState(null);
  const savedPositionsRef = useRef({});
  const reactFlowInstance = useReactFlow();

  // Load saved positions from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(POSITIONS_KEY);
      if (saved) {
        savedPositionsRef.current = JSON.parse(saved);
      }
    } catch (e) {
      console.error('Failed to load saved positions', e);
    }
  }, []);

  // Save positions when nodes change
  const savePositions = useCallback(() => {
    const positions = {};
    nodes.forEach(node => {
      positions[node.id] = node.position;
    });
    savedPositionsRef.current = positions;
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  }, [nodes]);

  // Handle node drag stop - save position
  const onNodeDragStop = useCallback((event, node) => {
    savedPositionsRef.current[node.id] = node.position;
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(savedPositionsRef.current));
  }, []);

  // Transform API data to React Flow nodes
  useEffect(() => {
    if (wsNodes.length === 0) return;

    const layoutNodes = calculateLayout(wsNodes, savedPositionsRef.current);

    const flowNodes = layoutNodes.map((nodeData) => {
      const nodeType = getNodeType(nodeData);
      const cluster = getCluster(nodeData);  // Pass full node data for actual cluster label

      return {
        id: nodeData.node_id,
        type: nodeType,
        position: nodeData.position,
        data: {
          ...nodeData,
          cluster,
          is_idle: nodeType === 'roamer' && (nodeData.cpu || 0) < 10,
          onDiskCleanup: () => setDiskCleanupNode({ node_id: nodeData.node_id, ip: nodeData.ip }),
        },
        draggable: true,
        selectable: true,
      };
    });

    // Only set positions on first load, then just update data
    if (!isInitialized && flowNodes.length > 0) {
      setNodes(flowNodes);
      setIsInitialized(true);

      // Load saved edges or create default ones
      const savedEdges = localStorage.getItem(EDGES_KEY);
      if (savedEdges) {
        try {
          setEdges(JSON.parse(savedEdges));
        } catch (e) {
          createDefaultEdges(flowNodes);
        }
      } else {
        createDefaultEdges(flowNodes);
      }
    } else {
      // Update existing nodes data without changing positions
      setNodes((nds) =>
        nds.map((n) => {
          const update = flowNodes.find((fn) => fn.id === n.id);
          if (update) {
            return { ...n, data: update.data };
          }
          return n;
        })
      );

      // Update edge data for traffic animation
      setEdges((eds) =>
        eds.map((e) => {
          const targetNode = flowNodes.find((n) => n.id === e.target);
          if (targetNode) {
            return {
              ...e,
              data: {
                ...e.data,
                active: (targetNode.data.cpu || 0) > 5,
                traffic: Math.min(
                  (targetNode.data.cpu || 0) + (targetNode.data.gpu?.utilization || 0),
                  100
                ) / 2,
              },
            };
          }
          return e;
        })
      );

      // Add new nodes if any
      const newNodes = flowNodes.filter((fn) => !nodes.find((n) => n.id === fn.id));
      if (newNodes.length > 0) {
        setNodes((nds) => [...nds, ...newNodes]);
      }
    }
  }, [wsNodes, isInitialized]);

  const createDefaultEdges = (flowNodes) => {
    const sparkNode = flowNodes.find(n => n.type === 'spark');
    if (sparkNode) {
      const newEdges = flowNodes
        .filter(n => n.type !== 'spark')
        .map((n) => ({
          id: `e-${sparkNode.id}-${n.id}`,
          source: sparkNode.id,
          target: n.id,
          type: 'animated',
          deletable: true,
          data: {
            active: (n.data.cpu || 0) > 5,
            traffic: Math.min((n.data.cpu || 0) + (n.data.gpu?.utilization || 0), 100) / 2,
          },
        }));
      setEdges(newEdges);
      localStorage.setItem(EDGES_KEY, JSON.stringify(newEdges));
    }
  };

  // Save edges when they change
  const handleEdgesChange = useCallback((changes) => {
    onEdgesChange(changes);
    // Save after state updates
    setTimeout(() => {
      const currentEdges = reactFlowInstance.getEdges();
      localStorage.setItem(EDGES_KEY, JSON.stringify(currentEdges));
    }, 100);
  }, [onEdgesChange, reactFlowInstance]);

  const onConnect = useCallback(
    (params) => {
      const newEdge = {
        ...params,
        type: 'animated',
        deletable: true,
        data: { active: true, traffic: 50 }
      };
      setEdges((eds) => {
        const updated = addEdge(newEdge, eds);
        localStorage.setItem(EDGES_KEY, JSON.stringify(updated));
        return updated;
      });
    },
    [setEdges]
  );

  const onNodeClick = useCallback((event, node) => {
    if (onNodeSelect) {
      onNodeSelect(node);
    }
  }, [onNodeSelect]);

  const onPaneClick = useCallback(() => {
    if (onNodeSelect) {
      onNodeSelect(null);
    }
    setSelectedNodes([]);
    setSelectedEdges([]);
  }, [onNodeSelect]);

  // Handle selection changes
  const onSelectionChange = useCallback(({ nodes: selNodes, edges: selEdges }) => {
    setSelectedNodes(selNodes || []);
    setSelectedEdges(selEdges || []);
  }, []);

  // Delete selected edges
  const deleteSelectedEdges = useCallback(() => {
    if (selectedEdges.length > 0) {
      const selectedIds = selectedEdges.map(e => e.id);
      setEdges((eds) => {
        const updated = eds.filter(e => !selectedIds.includes(e.id));
        localStorage.setItem(EDGES_KEY, JSON.stringify(updated));
        return updated;
      });
      setSelectedEdges([]);
    }
  }, [selectedEdges, setEdges]);

  // Reset layout
  const resetLayout = useCallback(() => {
    localStorage.removeItem(POSITIONS_KEY);
    localStorage.removeItem(EDGES_KEY);
    savedPositionsRef.current = {};
    setIsInitialized(false);
  }, []);

  // Auto-layout nodes
  const autoLayout = useCallback(() => {
    const layoutNodes = calculateLayout(wsNodes, {});
    const flowNodes = layoutNodes.map((nodeData) => {
      const nodeType = getNodeType(nodeData);
      const cluster = getCluster(nodeData);  // Pass full node data for actual cluster label
      return {
        id: nodeData.node_id,
        type: nodeType,
        position: nodeData.position,
        data: {
          ...nodeData,
          cluster,
          is_idle: nodeType === 'roamer' && (nodeData.cpu || 0) < 10,
          onDiskCleanup: () => setDiskCleanupNode({ node_id: nodeData.node_id, ip: nodeData.ip }),
        },
        draggable: true,
        selectable: true,
      };
    });
    setNodes(flowNodes);
    savePositions();
    reactFlowInstance.fitView({ padding: 0.2 });
  }, [wsNodes, setNodes, savePositions, reactFlowInstance]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedEdges.length > 0) {
          deleteSelectedEdges();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedEdges, deleteSelectedEdges]);

  return (
    <div className="h-full w-full bg-bg-primary relative">
      {/* SVG Filters for glow effects */}
      <svg width="0" height="0">
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
      </svg>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={onPaneClick}
        onSelectionChange={onSelectionChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        className="bg-bg-primary"
        minZoom={0.3}
        maxZoom={1.5}
        selectNodesOnDrag={false}
        selectionOnDrag
        panOnDrag={[1, 2]}
        selectionMode="partial"
        deleteKeyCode={['Backspace', 'Delete']}
        multiSelectionKeyCode="Shift"
        defaultEdgeOptions={{
          type: 'animated',
          deletable: true,
        }}
        connectionLineStyle={{ stroke: '#00d4ff', strokeWidth: 2 }}
        connectionLineType="smoothstep"
      >
        <Background color="#1a1a24" gap={24} size={1} />
        <Controls className="!bg-bg-tertiary !border-border-subtle !rounded-lg" />
        <MiniMap
          nodeColor={(node) => {
            switch (node.type) {
              case 'spark':
                return '#76b900';
              case 'roamer':
                return node.data?.is_idle ? '#666666' : '#00aaff';
              default:
                return '#3498db';
            }
          }}
          maskColor="rgba(0, 0, 0, 0.8)"
          className="!bg-bg-secondary !border-border-subtle !rounded-lg"
        />

        {/* Top Toolbar */}
        <Panel position="top-left" className="flex items-center gap-2">
          {/* Cluster Actions */}
          <div className="flex items-center gap-1 bg-bg-secondary border border-border-subtle rounded-lg p-1">
            <button
              onClick={() => setShowClusterModal(true)}
              className="p-2 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
              title="Create Cluster"
            >
              <Layers size={16} />
            </button>
            <button
              onClick={() => setShowDeployModal(true)}
              className="p-2 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
              title="Deploy Container"
            >
              <Container size={16} />
            </button>
            <button
              onClick={() => {}}
              className="p-2 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
              title="Swarm Manager"
            >
              <Network size={16} />
            </button>
          </div>

          {/* Edge Actions */}
          <div className="flex items-center gap-1 bg-bg-secondary border border-border-subtle rounded-lg p-1">
            <button
              onClick={deleteSelectedEdges}
              disabled={selectedEdges.length === 0}
              className={clsx(
                'p-2 rounded transition-colors',
                selectedEdges.length > 0
                  ? 'hover:bg-status-error/20 text-status-error'
                  : 'text-text-muted cursor-not-allowed'
              )}
              title="Delete Selected Edges (Del)"
            >
              <Unlink size={16} />
            </button>
          </div>

          {/* Layout Actions */}
          <div className="flex items-center gap-1 bg-bg-secondary border border-border-subtle rounded-lg p-1">
            <button
              onClick={autoLayout}
              className="p-2 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
              title="Auto Layout"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              onClick={resetLayout}
              className="p-2 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
              title="Reset Layout"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </Panel>

        {/* Status Panel */}
        <Panel position="top-right" className="flex items-center gap-4">
          <div
            className={clsx(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm',
              isConnected ? 'bg-status-online/10 text-status-online' : 'bg-status-error/10 text-status-error'
            )}
          >
            {isConnected ? <Wifi size={14} /> : <WifiOff size={14} />}
            <span>{isConnected ? 'Live' : 'Disconnected'}</span>
          </div>

          <div className="text-text-muted text-xs">
            {lastUpdate && `Updated ${lastUpdate.toLocaleTimeString()}`}
          </div>

          <button
            onClick={reconnect}
            className="p-2 rounded-lg bg-bg-tertiary border border-border-subtle hover:border-border-bright text-text-secondary hover:text-text-primary transition-colors"
            title="Reconnect"
          >
            <RefreshCw size={14} />
          </button>

          <button
            onClick={() => {
              const rf = document.querySelector('.react-flow');
              if (rf?.requestFullscreen) rf.requestFullscreen();
            }}
            className="p-2 rounded-lg bg-bg-tertiary border border-border-subtle hover:border-border-bright text-text-secondary hover:text-text-primary transition-colors"
            title="Fullscreen"
          >
            <Maximize2 size={14} />
          </button>
        </Panel>

        {/* Selection Info Panel */}
        {(selectedNodes.length > 0 || selectedEdges.length > 0) && (
          <Panel position="bottom-center" className="bg-bg-secondary border border-border-subtle rounded-lg px-4 py-2">
            <div className="flex items-center gap-4 text-sm">
              {selectedNodes.length > 0 && (
                <span className="text-text-primary">
                  {selectedNodes.length} node{selectedNodes.length > 1 ? 's' : ''} selected
                </span>
              )}
              {selectedEdges.length > 0 && (
                <span className="text-text-primary">
                  {selectedEdges.length} edge{selectedEdges.length > 1 ? 's' : ''} selected
                </span>
              )}
              <span className="text-text-muted text-xs">Press Del to delete edges</span>
            </div>
          </Panel>
        )}

        {/* Node Count Panel */}
        <Panel position="bottom-left" className="text-text-muted text-xs">
          {nodes.length} nodes • {edges.length} connections
        </Panel>
      </ReactFlow>

      {/* Create Cluster Modal */}
      {showClusterModal && (
        <ClusterModal
          nodes={nodes}
          selectedNodes={selectedNodes}
          onClose={() => setShowClusterModal(false)}
        />
      )}

      {/* Deploy Container Modal */}
      {showDeployModal && (
        <DeployModal
          nodes={nodes}
          selectedNodes={selectedNodes}
          onClose={() => setShowDeployModal(false)}
        />
      )}

      {/* Disk Cleanup Modal */}
      {diskCleanupNode && (
        <DiskCleanupModal
          isOpen={true}
          onClose={() => setDiskCleanupNode(null)}
          nodeId={diskCleanupNode.node_id}
          nodeIp={diskCleanupNode.ip}
        />
      )}
    </div>
  );
};

// Cluster Creation Modal
const ClusterModal = ({ nodes, selectedNodes, onClose }) => {
  const [clusterName, setClusterName] = useState('');
  const [clusterType, setClusterType] = useState('swarm');
  const [selectedNodeIds, setSelectedNodeIds] = useState(
    selectedNodes.map(n => n.id)
  );
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState(null);

  const workerNodes = nodes.filter(n => n.type !== 'spark');

  const handleCreate = async () => {
    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch(`${API_URL}/clusters/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: clusterName,
          cluster_type: clusterType,
          node_ids: selectedNodeIds,
          manager_node_id: selectedNodeIds[0] || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to create cluster');
      }

      const result = await response.json();
      console.log('Cluster created:', result);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-bg-secondary rounded-lg w-full max-w-lg border border-border-subtle">
        <div className="p-4 border-b border-border-subtle">
          <h2 className="text-lg font-bold text-text-primary">Create Cluster</h2>
          <p className="text-text-muted text-sm">Group nodes into a logical cluster</p>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Cluster Name</label>
            <input
              type="text"
              value={clusterName}
              onChange={(e) => setClusterName(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent"
              placeholder="e.g., vision-cluster"
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Cluster Type</label>
            <select
              value={clusterType}
              onChange={(e) => setClusterType(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent"
            >
              <option value="swarm">Docker Swarm</option>
              <option value="logical">Logical Group</option>
              <option value="kubernetes">Kubernetes (Coming Soon)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-2">Select Nodes</label>
            <div className="max-h-48 overflow-auto space-y-2">
              {workerNodes.map(node => (
                <label
                  key={node.id}
                  className="flex items-center gap-2 p-2 bg-bg-tertiary rounded-lg cursor-pointer hover:bg-bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={selectedNodeIds.includes(node.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedNodeIds([...selectedNodeIds, node.id]);
                      } else {
                        setSelectedNodeIds(selectedNodeIds.filter(id => id !== node.id));
                      }
                    }}
                    className="rounded"
                  />
                  <span className="text-text-primary">{node.id}</span>
                  <span className="text-text-muted text-xs ml-auto">{node.data?.cluster}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="px-4 pb-4">
            <div className="p-3 bg-status-error/10 border border-status-error/20 rounded-lg text-status-error text-sm">
              {error}
            </div>
          </div>
        )}

        <div className="p-4 border-t border-border-subtle flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isCreating}
            className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!clusterName || selectedNodeIds.length === 0 || isCreating}
            className="px-4 py-2 bg-text-accent hover:bg-text-accent/80 text-bg-primary rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isCreating ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                Creating...
              </>
            ) : (
              'Create Cluster'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// Deploy Container Modal
const DeployModal = ({ nodes, selectedNodes, onClose }) => {
  const [containerImage, setContainerImage] = useState('');
  const [containerName, setContainerName] = useState('');
  const [selectedNodeIds, setSelectedNodeIds] = useState(
    selectedNodes.map(n => n.id)
  );
  const [replicas, setReplicas] = useState(1);
  const [deployMode, setDeployMode] = useState('replicated');
  const [isDeploying, setIsDeploying] = useState(false);
  const [error, setError] = useState(null);

  const workerNodes = nodes.filter(n => n.type !== 'spark');

  const presetImages = [
    { name: 'NVIDIA L4T Base', image: 'nvcr.io/nvidia/l4t-base:r32.6.1' },
    { name: 'PyTorch', image: 'nvcr.io/nvidia/l4t-pytorch:r32.6.1-pth1.9-py3' },
    { name: 'TensorFlow', image: 'nvcr.io/nvidia/l4t-tensorflow:r32.6.1-tf2.5-py3' },
    { name: 'Ollama', image: 'ollama/ollama:latest' },
    { name: 'ComfyUI', image: 'comfyui:latest' },
  ];

  const handleDeploy = async () => {
    setIsDeploying(true);
    setError(null);

    try {
      // Build constraints based on selected nodes
      const constraints = selectedNodeIds.length > 0 && deployMode !== 'global'
        ? selectedNodeIds.map(id => `node.hostname==${id}`)
        : null;

      const response = await fetch(`${API_URL}/swarm/services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: containerName,
          image: containerImage,
          replicas: deployMode === 'global' ? 1 : replicas,
          mode: deployMode,
          constraints: constraints,
          resources: { gpu: 1 }, // Request GPU by default for Jetson nodes
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Failed to deploy service');
      }

      const result = await response.json();
      console.log('Service deployed:', result);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-bg-secondary rounded-lg w-full max-w-lg border border-border-subtle max-h-[90vh] overflow-auto">
        <div className="p-4 border-b border-border-subtle">
          <h2 className="text-lg font-bold text-text-primary">Deploy Container</h2>
          <p className="text-text-muted text-sm">Deploy a Docker container to selected nodes</p>
        </div>

        <div className="p-4 space-y-4">
          {/* Preset Images */}
          <div>
            <label className="block text-sm text-text-secondary mb-2">Quick Select</label>
            <div className="flex flex-wrap gap-2">
              {presetImages.map(preset => (
                <button
                  key={preset.image}
                  onClick={() => {
                    setContainerImage(preset.image);
                    setContainerName(preset.name.toLowerCase().replace(/\s+/g, '-'));
                  }}
                  className={clsx(
                    'px-3 py-1 text-xs rounded-lg border transition-colors',
                    containerImage === preset.image
                      ? 'bg-text-accent/20 border-text-accent text-text-accent'
                      : 'bg-bg-tertiary border-border-subtle text-text-secondary hover:text-text-primary'
                  )}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Container Image</label>
            <input
              type="text"
              value={containerImage}
              onChange={(e) => setContainerImage(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent font-mono text-sm"
              placeholder="e.g., nginx:latest"
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Service Name</label>
            <input
              type="text"
              value={containerName}
              onChange={(e) => setContainerName(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent"
              placeholder="e.g., my-service"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1">Deploy Mode</label>
              <select
                value={deployMode}
                onChange={(e) => setDeployMode(e.target.value)}
                className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent"
              >
                <option value="replicated">Replicated</option>
                <option value="global">Global (All Nodes)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm text-text-secondary mb-1">Replicas</label>
              <input
                type="number"
                value={replicas}
                onChange={(e) => setReplicas(parseInt(e.target.value) || 1)}
                min={1}
                max={selectedNodeIds.length || 10}
                disabled={deployMode === 'global'}
                className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent disabled:opacity-50"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-2">Target Nodes</label>
            <div className="max-h-40 overflow-auto space-y-2">
              {workerNodes.map(node => (
                <label
                  key={node.id}
                  className="flex items-center gap-2 p-2 bg-bg-tertiary rounded-lg cursor-pointer hover:bg-bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={selectedNodeIds.includes(node.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedNodeIds([...selectedNodeIds, node.id]);
                      } else {
                        setSelectedNodeIds(selectedNodeIds.filter(id => id !== node.id));
                      }
                    }}
                    className="rounded"
                  />
                  <span className="text-text-primary">{node.id}</span>
                  <span className="text-text-muted text-xs ml-auto">
                    CPU: {node.data?.cpu?.toFixed(0)}% | GPU: {node.data?.gpu?.utilization?.toFixed(0) || 0}%
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="px-4 pb-4">
            <div className="p-3 bg-status-error/10 border border-status-error/20 rounded-lg text-status-error text-sm">
              {error}
            </div>
          </div>
        )}

        <div className="p-4 border-t border-border-subtle flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isDeploying}
            className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleDeploy}
            disabled={!containerImage || !containerName || isDeploying}
            className="px-4 py-2 bg-cluster-spark hover:bg-cluster-spark/80 text-white rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isDeploying ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                Deploying...
              </>
            ) : (
              'Deploy to Swarm'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// Wrap with ReactFlowProvider
const CanvasView = (props) => (
  <ReactFlowProvider>
    <CanvasViewInner {...props} />
  </ReactFlowProvider>
);

export default CanvasView;
