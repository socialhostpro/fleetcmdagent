import React, { useCallback, useEffect, useState } from 'react';
import ReactFlow, { 
  Background, 
  Controls, 
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge
} from 'reactflow';
import 'reactflow/dist/style.css';
import { fetchNodes } from '../api';
import { Server, Cpu, Activity } from 'lucide-react';

const nodeTypes = {
  // Custom node types can be defined here
};

const CanvasView = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const refreshNodes = async () => {
    try {
      const activeNodes = await fetchNodes();
      
      // Transform API data to React Flow nodes
      const flowNodes = activeNodes.map((node, index) => ({
        id: node.node_id,
        type: 'default',
        position: { x: 250 * (index % 4), y: 150 * Math.floor(index / 4) },
        data: { 
          label: (
            <div className="p-2 border border-gray-700 rounded bg-gray-800 text-white w-48">
              <div className="flex items-center gap-2 border-b border-gray-700 pb-1 mb-1">
                <Server size={16} className="text-green-400" />
                <span className="font-bold text-sm">{node.node_id}</span>
              </div>
              <div className="text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-400">CPU</span>
                  <span className="text-blue-300">{node.cpu}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">RAM</span>
                  <span className="text-purple-300">{node.memory.percent}%</span>
                </div>
              </div>
            </div>
          )
        },
      }));

      if (flowNodes.length > 0 || nodes.length > 0) {
         if (nodes.length === 0) {
             setNodes(flowNodes);
         } else {
             setNodes((nds) => nds.map((n) => {
                 const update = flowNodes.find(fn => fn.id === n.id);
                 return update ? { ...n, data: update.data } : n;
             }));
             const newNodes = flowNodes.filter(fn => !nodes.find(n => n.id === fn.id));
             if (newNodes.length > 0) setNodes((nds) => [...nds, ...newNodes]);
         }
      }
    } catch (error) {
      console.error("Failed to fetch nodes", error);
    }
  };

  useEffect(() => {
    refreshNodes();
    const interval = setInterval(refreshNodes, 5000);
    return () => clearInterval(interval);
  }, []);

  const onConnect = useCallback((params) => setEdges((eds) => addEdge(params, eds)), [setEdges]);

  return (
    <div className="h-full w-full bg-gray-900">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        fitView
        className="bg-gray-950"
      >
        <Background color="#333" gap={16} />
        <Controls />
        <MiniMap nodeColor="#444" maskColor="#00000080" />
      </ReactFlow>
    </div>
  );
};

export default CanvasView;
