import React, { useCallback, useState, useRef } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Panel,
  ReactFlowProvider,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  Play, Save, FolderOpen, Plus, Trash2, Settings,
  Film, Scissors, Wand2, CheckCircle, Sparkles, Upload,
  Eye, Layers, Move, Palette, Zap, AlertTriangle
} from 'lucide-react';
import clsx from 'clsx';

// Pipeline node types
import InputNode from '../components/workflow/InputNode';
import SegmentNode from '../components/workflow/SegmentNode';
import WarpNode from '../components/workflow/WarpNode';
import RenderNode from '../components/workflow/RenderNode';
import QCNode from '../components/workflow/QCNode';
import FixNode from '../components/workflow/FixNode';
import OutputNode from '../components/workflow/OutputNode';

const API_URL = `http://${window.location.hostname}:8765/api`;

const nodeTypes = {
  input: InputNode,
  segment: SegmentNode,
  warp: WarpNode,
  render: RenderNode,
  qc: QCNode,
  fix: FixNode,
  output: OutputNode,
};

// Node templates for the palette
const nodeTemplates = [
  { type: 'input', label: 'Input', icon: Upload, color: 'text-blue-400', description: 'Source media input' },
  { type: 'segment', label: 'Segment', icon: Scissors, color: 'text-purple-400', description: 'SAM segmentation' },
  { type: 'warp', label: 'Warp', icon: Move, color: 'text-cyan-400', description: 'Motion warp preview' },
  { type: 'render', label: 'Render', icon: Sparkles, color: 'text-green-400', description: 'AI render (SD/Flux)' },
  { type: 'qc', label: 'QC', icon: CheckCircle, color: 'text-yellow-400', description: 'Quality control' },
  { type: 'fix', label: 'Fix', icon: Wand2, color: 'text-orange-400', description: 'Auto-fix pass' },
  { type: 'output', label: 'Output', icon: Film, color: 'text-red-400', description: 'Final delivery' },
];

// Preset workflows
const presetWorkflows = {
  'simple-render': {
    name: 'Simple Render',
    description: 'Basic image-to-image transformation',
    category: 'basic',
    nodes: [
      { id: 'input-1', type: 'input', position: { x: 100, y: 200 }, data: { label: 'Source' } },
      { id: 'render-1', type: 'render', position: { x: 400, y: 200 }, data: { label: 'Render', model: 'flux' } },
      { id: 'output-1', type: 'output', position: { x: 700, y: 200 }, data: { label: 'Output' } },
    ],
    edges: [
      { id: 'e1', source: 'input-1', target: 'render-1', animated: true },
      { id: 'e2', source: 'render-1', target: 'output-1', animated: true },
    ],
  },
  'previz-pipeline': {
    name: 'Previz Pipeline',
    description: 'Quick preview with segmentation and motion',
    category: 'basic',
    nodes: [
      { id: 'input-1', type: 'input', position: { x: 50, y: 200 }, data: { label: 'Source' } },
      { id: 'segment-1', type: 'segment', position: { x: 250, y: 200 }, data: { label: 'Segment', model: 'sam' } },
      { id: 'warp-1', type: 'warp', position: { x: 450, y: 200 }, data: { label: 'Warp Preview' } },
      { id: 'render-1', type: 'render', position: { x: 650, y: 200 }, data: { label: 'AI Preview', quality: 'preview' } },
      { id: 'output-1', type: 'output', position: { x: 850, y: 200 }, data: { label: 'Preview' } },
    ],
    edges: [
      { id: 'e1', source: 'input-1', target: 'segment-1', animated: true },
      { id: 'e2', source: 'segment-1', target: 'warp-1', animated: true },
      { id: 'e3', source: 'warp-1', target: 'render-1', animated: true },
      { id: 'e4', source: 'render-1', target: 'output-1', animated: true },
    ],
  },
  'production-qc': {
    name: 'Production + QC',
    description: 'Full production with quality checks and auto-fix',
    category: 'production',
    nodes: [
      { id: 'input-1', type: 'input', position: { x: 50, y: 150 }, data: { label: 'Source' } },
      { id: 'segment-1', type: 'segment', position: { x: 220, y: 150 }, data: { label: 'Segment' } },
      { id: 'render-1', type: 'render', position: { x: 400, y: 150 }, data: { label: 'Render', quality: 'high' } },
      { id: 'qc-1', type: 'qc', position: { x: 580, y: 150 }, data: { label: 'QC Check', thresholds: { stability: 0.8, sharpness: 0.7 } } },
      { id: 'fix-1', type: 'fix', position: { x: 580, y: 300 }, data: { label: 'Auto-Fix', actions: ['denoise', 'upscale'] } },
      { id: 'output-1', type: 'output', position: { x: 780, y: 150 }, data: { label: 'Final' } },
    ],
    edges: [
      { id: 'e1', source: 'input-1', target: 'segment-1', animated: true },
      { id: 'e2', source: 'segment-1', target: 'render-1', animated: true },
      { id: 'e3', source: 'render-1', target: 'qc-1', animated: true },
      { id: 'e4', source: 'qc-1', target: 'output-1', animated: true, label: 'pass' },
      { id: 'e5', source: 'qc-1', target: 'fix-1', animated: true, label: 'fail', style: { stroke: '#f59e0b' } },
      { id: 'e6', source: 'fix-1', target: 'qc-1', animated: true, style: { stroke: '#f59e0b' } },
    ],
  },
  'video-generation': {
    name: 'Video Generation',
    description: 'AnimateDiff video from single image',
    category: 'video',
    nodes: [
      { id: 'input-1', type: 'input', position: { x: 50, y: 200 }, data: { label: 'Reference Frame', sourceType: 'image' } },
      { id: 'segment-1', type: 'segment', position: { x: 230, y: 200 }, data: { label: 'Extract Subject', model: 'sam2', trackMotion: true } },
      { id: 'warp-1', type: 'warp', position: { x: 410, y: 200 }, data: { label: 'Motion Path', frames: 24 } },
      { id: 'render-1', type: 'render', position: { x: 590, y: 200 }, data: { label: 'AnimateDiff', model: 'animatediff', steps: 25 } },
      { id: 'qc-1', type: 'qc', position: { x: 770, y: 200 }, data: { label: 'Frame QC', thresholds: { stability: 0.85, consistency: 0.9 } } },
      { id: 'output-1', type: 'output', position: { x: 950, y: 200 }, data: { label: 'Video Out', format: 'mp4' } },
    ],
    edges: [
      { id: 'e1', source: 'input-1', target: 'segment-1', animated: true },
      { id: 'e2', source: 'segment-1', target: 'warp-1', animated: true },
      { id: 'e3', source: 'warp-1', target: 'render-1', animated: true },
      { id: 'e4', source: 'render-1', target: 'qc-1', animated: true },
      { id: 'e5', source: 'qc-1', target: 'output-1', animated: true },
    ],
  },
  'upscale-enhance': {
    name: 'Upscale & Enhance',
    description: '4K upscale with face and hand restoration',
    category: 'production',
    nodes: [
      { id: 'input-1', type: 'input', position: { x: 50, y: 150 }, data: { label: 'Low-Res Input' } },
      { id: 'segment-1', type: 'segment', position: { x: 220, y: 150 }, data: { label: 'Detect Faces/Hands', model: 'sam' } },
      { id: 'fix-1', type: 'fix', position: { x: 400, y: 80 }, data: { label: 'Face Restore', actions: ['face_restore'] } },
      { id: 'fix-2', type: 'fix', position: { x: 400, y: 220 }, data: { label: 'Hand Fix', actions: ['hand_fix'] } },
      { id: 'render-1', type: 'render', position: { x: 600, y: 150 }, data: { label: '4x Upscale', model: 'sdxl', quality: 'high' } },
      { id: 'qc-1', type: 'qc', position: { x: 780, y: 150 }, data: { label: 'Quality Check', thresholds: { sharpness: 0.85, identity: 0.9 } } },
      { id: 'output-1', type: 'output', position: { x: 960, y: 150 }, data: { label: '4K Output' } },
    ],
    edges: [
      { id: 'e1', source: 'input-1', target: 'segment-1', animated: true },
      { id: 'e2', source: 'segment-1', target: 'fix-1', animated: true },
      { id: 'e3', source: 'segment-1', target: 'fix-2', animated: true },
      { id: 'e4', source: 'fix-1', target: 'render-1', animated: true },
      { id: 'e5', source: 'fix-2', target: 'render-1', animated: true },
      { id: 'e6', source: 'render-1', target: 'qc-1', animated: true },
      { id: 'e7', source: 'qc-1', target: 'output-1', animated: true },
    ],
  },
  'style-transfer': {
    name: 'Style Transfer',
    description: 'Apply reference style to source images',
    category: 'creative',
    nodes: [
      { id: 'input-1', type: 'input', position: { x: 50, y: 120 }, data: { label: 'Content Image' } },
      { id: 'input-2', type: 'input', position: { x: 50, y: 280 }, data: { label: 'Style Reference' } },
      { id: 'segment-1', type: 'segment', position: { x: 250, y: 120 }, data: { label: 'Extract Content', model: 'sam' } },
      { id: 'render-1', type: 'render', position: { x: 480, y: 200 }, data: { label: 'Style Apply', model: 'sdxl', steps: 30 } },
      { id: 'qc-1', type: 'qc', position: { x: 680, y: 200 }, data: { label: 'Style Match QC', thresholds: { style_match: 0.75, content_preserve: 0.8 } } },
      { id: 'output-1', type: 'output', position: { x: 880, y: 200 }, data: { label: 'Styled Output' } },
    ],
    edges: [
      { id: 'e1', source: 'input-1', target: 'segment-1', animated: true },
      { id: 'e2', source: 'segment-1', target: 'render-1', animated: true },
      { id: 'e3', source: 'input-2', target: 'render-1', animated: true, style: { stroke: '#a855f7' } },
      { id: 'e4', source: 'render-1', target: 'qc-1', animated: true },
      { id: 'e5', source: 'qc-1', target: 'output-1', animated: true },
    ],
  },
  'character-turnaround': {
    name: 'Character Turnaround',
    description: 'Generate consistent character views',
    category: 'creative',
    nodes: [
      { id: 'input-1', type: 'input', position: { x: 50, y: 200 }, data: { label: 'Character Ref' } },
      { id: 'segment-1', type: 'segment', position: { x: 220, y: 200 }, data: { label: 'Extract Character', model: 'sam2' } },
      { id: 'warp-1', type: 'warp', position: { x: 390, y: 100 }, data: { label: 'Front View', rotation: 0 } },
      { id: 'warp-2', type: 'warp', position: { x: 390, y: 200 }, data: { label: 'Side View', rotation: 90 } },
      { id: 'warp-3', type: 'warp', position: { x: 390, y: 300 }, data: { label: 'Back View', rotation: 180 } },
      { id: 'render-1', type: 'render', position: { x: 580, y: 100 }, data: { label: 'Render Front', model: 'flux', quality: 'high' } },
      { id: 'render-2', type: 'render', position: { x: 580, y: 200 }, data: { label: 'Render Side', model: 'flux', quality: 'high' } },
      { id: 'render-3', type: 'render', position: { x: 580, y: 300 }, data: { label: 'Render Back', model: 'flux', quality: 'high' } },
      { id: 'qc-1', type: 'qc', position: { x: 770, y: 200 }, data: { label: 'Consistency QC', thresholds: { identity: 0.95, consistency: 0.9 } } },
      { id: 'output-1', type: 'output', position: { x: 960, y: 200 }, data: { label: 'Turnaround Sheet' } },
    ],
    edges: [
      { id: 'e1', source: 'input-1', target: 'segment-1', animated: true },
      { id: 'e2', source: 'segment-1', target: 'warp-1', animated: true },
      { id: 'e3', source: 'segment-1', target: 'warp-2', animated: true },
      { id: 'e4', source: 'segment-1', target: 'warp-3', animated: true },
      { id: 'e5', source: 'warp-1', target: 'render-1', animated: true },
      { id: 'e6', source: 'warp-2', target: 'render-2', animated: true },
      { id: 'e7', source: 'warp-3', target: 'render-3', animated: true },
      { id: 'e8', source: 'render-1', target: 'qc-1', animated: true },
      { id: 'e9', source: 'render-2', target: 'qc-1', animated: true },
      { id: 'e10', source: 'render-3', target: 'qc-1', animated: true },
      { id: 'e11', source: 'qc-1', target: 'output-1', animated: true },
    ],
  },
  'vfx-full-pipeline': {
    name: 'Full VFX Pipeline',
    description: 'Complete Hollywood-style production workflow',
    category: 'production',
    nodes: [
      // Row 1: Input and Prep
      { id: 'input-1', type: 'input', position: { x: 50, y: 100 }, data: { label: 'Plate Input', sourceType: 'sequence' } },
      { id: 'input-2', type: 'input', position: { x: 50, y: 250 }, data: { label: 'Reference Art' } },
      { id: 'segment-1', type: 'segment', position: { x: 220, y: 100 }, data: { label: 'Roto/Segment', model: 'sam2', trackMotion: true } },
      // Row 2: Motion and Layout
      { id: 'warp-1', type: 'warp', position: { x: 390, y: 100 }, data: { label: 'Camera Solve' } },
      { id: 'warp-2', type: 'warp', position: { x: 390, y: 250 }, data: { label: 'Motion Match' } },
      // Row 3: Rendering Passes
      { id: 'render-1', type: 'render', position: { x: 560, y: 50 }, data: { label: 'Beauty Pass', model: 'flux', quality: 'final', steps: 40 } },
      { id: 'render-2', type: 'render', position: { x: 560, y: 175 }, data: { label: 'FX Pass', model: 'sdxl', quality: 'high' } },
      { id: 'render-3', type: 'render', position: { x: 560, y: 300 }, data: { label: 'BG Extension', model: 'flux', quality: 'high' } },
      // Row 4: Compositing and QC
      { id: 'fix-1', type: 'fix', position: { x: 730, y: 175 }, data: { label: 'Composite', actions: ['denoise', 'color_match'] } },
      { id: 'qc-1', type: 'qc', position: { x: 900, y: 175 }, data: { label: 'Final QC', thresholds: { stability: 0.9, sharpness: 0.85, identity: 0.95 }, maxRetries: 3 } },
      { id: 'fix-2', type: 'fix', position: { x: 900, y: 320 }, data: { label: 'QC Fixes', actions: ['denoise', 'face_restore', 'hand_fix', 'interpolate'] } },
      { id: 'output-1', type: 'output', position: { x: 1070, y: 175 }, data: { label: 'Final Delivery', format: 'exr_sequence' } },
    ],
    edges: [
      // Input flow
      { id: 'e1', source: 'input-1', target: 'segment-1', animated: true },
      { id: 'e2', source: 'segment-1', target: 'warp-1', animated: true },
      { id: 'e3', source: 'input-2', target: 'warp-2', animated: true },
      // Warp to renders
      { id: 'e4', source: 'warp-1', target: 'render-1', animated: true },
      { id: 'e5', source: 'warp-1', target: 'render-2', animated: true },
      { id: 'e6', source: 'warp-2', target: 'render-3', animated: true },
      // Renders to composite
      { id: 'e7', source: 'render-1', target: 'fix-1', animated: true },
      { id: 'e8', source: 'render-2', target: 'fix-1', animated: true },
      { id: 'e9', source: 'render-3', target: 'fix-1', animated: true },
      // Composite to QC
      { id: 'e10', source: 'fix-1', target: 'qc-1', animated: true },
      // QC paths
      { id: 'e11', source: 'qc-1', target: 'output-1', animated: true, label: 'approved' },
      { id: 'e12', source: 'qc-1', target: 'fix-2', animated: true, label: 'fixes needed', style: { stroke: '#f59e0b' } },
      { id: 'e13', source: 'fix-2', target: 'qc-1', animated: true, style: { stroke: '#f59e0b' } },
    ],
  },
  'batch-render': {
    name: 'Batch Process',
    description: 'Process multiple images in parallel',
    category: 'basic',
    nodes: [
      { id: 'input-1', type: 'input', position: { x: 50, y: 200 }, data: { label: 'Batch Input', sourceType: 'folder' } },
      { id: 'segment-1', type: 'segment', position: { x: 250, y: 200 }, data: { label: 'Auto Segment', model: 'sam' } },
      { id: 'render-1', type: 'render', position: { x: 450, y: 200 }, data: { label: 'Batch Render', model: 'flux', quality: 'medium', parallel: true } },
      { id: 'qc-1', type: 'qc', position: { x: 650, y: 200 }, data: { label: 'Batch QC', thresholds: { min_quality: 0.7 } } },
      { id: 'output-1', type: 'output', position: { x: 850, y: 200 }, data: { label: 'Batch Output', format: 'preserve' } },
    ],
    edges: [
      { id: 'e1', source: 'input-1', target: 'segment-1', animated: true },
      { id: 'e2', source: 'segment-1', target: 'render-1', animated: true },
      { id: 'e3', source: 'render-1', target: 'qc-1', animated: true },
      { id: 'e4', source: 'qc-1', target: 'output-1', animated: true },
    ],
  },
  'motion-interpolate': {
    name: 'Frame Interpolation',
    description: 'Smooth video with AI frame interpolation',
    category: 'video',
    nodes: [
      { id: 'input-1', type: 'input', position: { x: 50, y: 200 }, data: { label: 'Video Input', sourceType: 'video' } },
      { id: 'segment-1', type: 'segment', position: { x: 230, y: 200 }, data: { label: 'Motion Analysis', model: 'sam2', trackMotion: true } },
      { id: 'warp-1', type: 'warp', position: { x: 410, y: 200 }, data: { label: 'Optical Flow' } },
      { id: 'fix-1', type: 'fix', position: { x: 590, y: 200 }, data: { label: 'Interpolate 2x', actions: ['interpolate'] } },
      { id: 'qc-1', type: 'qc', position: { x: 770, y: 200 }, data: { label: 'Motion QC', thresholds: { smoothness: 0.9, artifact_free: 0.85 } } },
      { id: 'output-1', type: 'output', position: { x: 950, y: 200 }, data: { label: '60fps Output', format: 'mp4', fps: 60 } },
    ],
    edges: [
      { id: 'e1', source: 'input-1', target: 'segment-1', animated: true },
      { id: 'e2', source: 'segment-1', target: 'warp-1', animated: true },
      { id: 'e3', source: 'warp-1', target: 'fix-1', animated: true },
      { id: 'e4', source: 'fix-1', target: 'qc-1', animated: true },
      { id: 'e5', source: 'qc-1', target: 'output-1', animated: true },
    ],
  },
};

const WorkflowDesignerInner = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [workflowName, setWorkflowName] = useState('Untitled Workflow');
  const [selectedNode, setSelectedNode] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const reactFlowWrapper = useRef(null);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge({ ...params, animated: true }, eds)),
    [setEdges]
  );

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow');
      if (!type || !reactFlowInstance) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newNode = {
        id: `${type}-${Date.now()}`,
        type,
        position,
        data: { label: type.charAt(0).toUpperCase() + type.slice(1) },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance, setNodes]
  );

  const onDragStart = (event, nodeType) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  const loadPreset = (presetKey) => {
    const preset = presetWorkflows[presetKey];
    if (preset) {
      setNodes(preset.nodes);
      setEdges(preset.edges);
      setWorkflowName(preset.name);
    }
  };

  const clearWorkflow = () => {
    setNodes([]);
    setEdges([]);
    setWorkflowName('Untitled Workflow');
  };

  const saveWorkflow = async () => {
    const workflow = {
      name: workflowName,
      nodes: nodes,
      edges: edges,
      created: new Date().toISOString(),
    };

    try {
      // Save to localStorage for now
      const saved = JSON.parse(localStorage.getItem('fleet-workflows') || '[]');
      saved.push(workflow);
      localStorage.setItem('fleet-workflows', JSON.stringify(saved));
      alert('Workflow saved!');
    } catch (err) {
      console.error('Save error:', err);
    }
  };

  const runWorkflow = async () => {
    if (nodes.length === 0) {
      alert('Add some nodes first!');
      return;
    }

    setIsRunning(true);
    try {
      const workflow = {
        name: workflowName,
        nodes: nodes.map(n => ({ id: n.id, type: n.type, data: n.data })),
        edges: edges.map(e => ({ source: e.source, target: e.target })),
      };

      const res = await fetch(`${API_URL}/director/workflow/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workflow),
      });

      if (!res.ok) throw new Error('Failed to start workflow');
      const data = await res.json();
      alert(`Workflow started! Job ID: ${data.job_id}`);
    } catch (err) {
      console.error('Run error:', err);
      alert('Failed to run workflow: ' + err.message);
    } finally {
      setIsRunning(false);
    }
  };

  const onNodeClick = useCallback((event, node) => {
    setSelectedNode(node);
  }, []);

  const deleteSelected = useCallback(() => {
    if (selectedNode) {
      setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id));
      setEdges((eds) => eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id));
      setSelectedNode(null);
    }
  }, [selectedNode, setNodes, setEdges]);

  return (
    <div className="h-full flex bg-bg-primary">
      {/* Left Sidebar - Node Palette */}
      <div className="w-64 bg-bg-secondary border-r border-border-subtle flex flex-col">
        <div className="p-4 border-b border-border-subtle">
          <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <Layers size={20} />
            Pipeline Nodes
          </h2>
          <p className="text-xs text-text-muted mt-1">Drag nodes to canvas</p>
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-2">
          {nodeTemplates.map((template) => (
            <div
              key={template.type}
              draggable
              onDragStart={(e) => onDragStart(e, template.type)}
              className="p-3 bg-bg-tertiary rounded-lg border border-border-subtle cursor-grab hover:border-text-accent transition-colors"
            >
              <div className="flex items-center gap-2">
                <template.icon size={18} className={template.color} />
                <span className="text-text-primary font-medium">{template.label}</span>
              </div>
              <p className="text-xs text-text-muted mt-1">{template.description}</p>
            </div>
          ))}
        </div>

        {/* Presets */}
        <div className="p-3 border-t border-border-subtle overflow-auto max-h-80">
          <h3 className="text-sm font-semibold text-text-secondary mb-2">Pipeline Presets</h3>

          {/* Basic */}
          <div className="mb-3">
            <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Basic</p>
            <div className="space-y-1">
              {Object.entries(presetWorkflows)
                .filter(([_, p]) => p.category === 'basic')
                .map(([key, preset]) => (
                  <button
                    key={key}
                    onClick={() => loadPreset(key)}
                    className="w-full text-left px-2 py-1.5 text-xs bg-bg-tertiary rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors group"
                    title={preset.description}
                  >
                    <span className="font-medium">{preset.name}</span>
                    <p className="text-text-muted text-[10px] truncate group-hover:text-text-secondary">{preset.description}</p>
                  </button>
                ))}
            </div>
          </div>

          {/* Video */}
          <div className="mb-3">
            <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Video</p>
            <div className="space-y-1">
              {Object.entries(presetWorkflows)
                .filter(([_, p]) => p.category === 'video')
                .map(([key, preset]) => (
                  <button
                    key={key}
                    onClick={() => loadPreset(key)}
                    className="w-full text-left px-2 py-1.5 text-xs bg-bg-tertiary rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors group"
                    title={preset.description}
                  >
                    <span className="font-medium">{preset.name}</span>
                    <p className="text-text-muted text-[10px] truncate group-hover:text-text-secondary">{preset.description}</p>
                  </button>
                ))}
            </div>
          </div>

          {/* Creative */}
          <div className="mb-3">
            <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Creative</p>
            <div className="space-y-1">
              {Object.entries(presetWorkflows)
                .filter(([_, p]) => p.category === 'creative')
                .map(([key, preset]) => (
                  <button
                    key={key}
                    onClick={() => loadPreset(key)}
                    className="w-full text-left px-2 py-1.5 text-xs bg-bg-tertiary rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors group"
                    title={preset.description}
                  >
                    <span className="font-medium">{preset.name}</span>
                    <p className="text-text-muted text-[10px] truncate group-hover:text-text-secondary">{preset.description}</p>
                  </button>
                ))}
            </div>
          </div>

          {/* Production */}
          <div className="mb-2">
            <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Production</p>
            <div className="space-y-1">
              {Object.entries(presetWorkflows)
                .filter(([_, p]) => p.category === 'production')
                .map(([key, preset]) => (
                  <button
                    key={key}
                    onClick={() => loadPreset(key)}
                    className="w-full text-left px-2 py-1.5 text-xs bg-bg-tertiary rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors group"
                    title={preset.description}
                  >
                    <span className="font-medium">{preset.name}</span>
                    <p className="text-text-muted text-[10px] truncate group-hover:text-text-secondary">{preset.description}</p>
                  </button>
                ))}
            </div>
          </div>
        </div>
      </div>

      {/* Main Canvas */}
      <div className="flex-1 flex flex-col">
        {/* Top Toolbar */}
        <div className="h-14 bg-bg-secondary border-b border-border-subtle flex items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <input
              type="text"
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              className="bg-bg-tertiary border border-border-subtle rounded px-3 py-1.5 text-text-primary focus:outline-none focus:border-text-accent"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={clearWorkflow}
              className="p-2 rounded hover:bg-bg-hover text-text-muted hover:text-status-error transition-colors"
              title="Clear workflow"
            >
              <Trash2 size={18} />
            </button>
            <button
              onClick={deleteSelected}
              disabled={!selectedNode}
              className="p-2 rounded hover:bg-bg-hover text-text-muted hover:text-status-error disabled:opacity-50 transition-colors"
              title="Delete selected"
            >
              <AlertTriangle size={18} />
            </button>
            <div className="w-px h-6 bg-border-subtle mx-2" />
            <button
              onClick={saveWorkflow}
              className="flex items-center gap-2 px-3 py-1.5 rounded bg-bg-tertiary hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
            >
              <Save size={16} />
              Save
            </button>
            <button
              onClick={runWorkflow}
              disabled={isRunning}
              className={clsx(
                "flex items-center gap-2 px-4 py-1.5 rounded font-medium transition-colors",
                isRunning
                  ? "bg-status-warning/20 text-status-warning"
                  : "bg-cluster-spark hover:bg-cluster-spark/80 text-white"
              )}
            >
              {isRunning ? (
                <>
                  <Zap size={16} className="animate-pulse" />
                  Running...
                </>
              ) : (
                <>
                  <Play size={16} />
                  Run Pipeline
                </>
              )}
            </button>
          </div>
        </div>

        {/* React Flow Canvas */}
        <div className="flex-1" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setReactFlowInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            className="bg-bg-primary"
            defaultEdgeOptions={{ animated: true, style: { stroke: '#00d4ff', strokeWidth: 2 } }}
          >
            <Background color="#1a1a24" gap={20} size={1} />
            <Controls className="!bg-bg-tertiary !border-border-subtle !rounded-lg" />
            <MiniMap
              nodeColor={(node) => {
                switch (node.type) {
                  case 'input': return '#3b82f6';
                  case 'segment': return '#a855f7';
                  case 'warp': return '#06b6d4';
                  case 'render': return '#22c55e';
                  case 'qc': return '#eab308';
                  case 'fix': return '#f97316';
                  case 'output': return '#ef4444';
                  default: return '#666';
                }
              }}
              maskColor="rgba(0, 0, 0, 0.8)"
              className="!bg-bg-secondary !border-border-subtle !rounded-lg"
            />

            {/* Instructions Panel */}
            {nodes.length === 0 && (
              <Panel position="top-center" className="bg-bg-secondary/90 border border-border-subtle rounded-lg p-6 text-center">
                <Layers size={32} className="text-text-accent mx-auto mb-3" />
                <h3 className="text-lg font-semibold text-text-primary mb-2">Design Your Pipeline</h3>
                <p className="text-text-muted text-sm max-w-md">
                  Drag nodes from the left panel to create your workflow.
                  Connect nodes to define the processing flow.
                  Use presets for quick start templates.
                </p>
              </Panel>
            )}
          </ReactFlow>
        </div>
      </div>

      {/* Right Sidebar - Node Properties */}
      {selectedNode && (
        <div className="w-72 bg-bg-secondary border-l border-border-subtle flex flex-col">
          <div className="p-4 border-b border-border-subtle">
            <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
              <Settings size={18} />
              Node Settings
            </h2>
            <p className="text-xs text-text-muted mt-1">{selectedNode.type}</p>
          </div>

          <div className="flex-1 overflow-auto p-4">
            <NodeProperties node={selectedNode} onChange={(data) => {
              setNodes((nds) => nds.map((n) =>
                n.id === selectedNode.id ? { ...n, data: { ...n.data, ...data } } : n
              ));
            }} />
          </div>
        </div>
      )}
    </div>
  );
};

// Node Properties Panel
const NodeProperties = ({ node, onChange }) => {
  switch (node.type) {
    case 'render':
      return (
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Model</label>
            <select
              value={node.data?.model || 'flux'}
              onChange={(e) => onChange({ model: e.target.value })}
              className="w-full bg-bg-tertiary border border-border-subtle rounded px-3 py-2 text-text-primary"
            >
              <option value="flux">Flux</option>
              <option value="sd15">Stable Diffusion 1.5</option>
              <option value="sdxl">SDXL</option>
              <option value="animatediff">AnimateDiff</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Quality</label>
            <select
              value={node.data?.quality || 'preview'}
              onChange={(e) => onChange({ quality: e.target.value })}
              className="w-full bg-bg-tertiary border border-border-subtle rounded px-3 py-2 text-text-primary"
            >
              <option value="preview">Preview (fast)</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="final">Final (slow)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Steps</label>
            <input
              type="number"
              value={node.data?.steps || 20}
              onChange={(e) => onChange({ steps: parseInt(e.target.value) })}
              className="w-full bg-bg-tertiary border border-border-subtle rounded px-3 py-2 text-text-primary"
              min={1}
              max={100}
            />
          </div>
        </div>
      );

    case 'qc':
      return (
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Stability Threshold</label>
            <input
              type="range"
              value={(node.data?.thresholds?.stability || 0.8) * 100}
              onChange={(e) => onChange({ thresholds: { ...node.data?.thresholds, stability: e.target.value / 100 } })}
              className="w-full"
              min={0}
              max={100}
            />
            <span className="text-xs text-text-muted">{((node.data?.thresholds?.stability || 0.8) * 100).toFixed(0)}%</span>
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Sharpness Threshold</label>
            <input
              type="range"
              value={(node.data?.thresholds?.sharpness || 0.7) * 100}
              onChange={(e) => onChange({ thresholds: { ...node.data?.thresholds, sharpness: e.target.value / 100 } })}
              className="w-full"
              min={0}
              max={100}
            />
            <span className="text-xs text-text-muted">{((node.data?.thresholds?.sharpness || 0.7) * 100).toFixed(0)}%</span>
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">Max Retries</label>
            <input
              type="number"
              value={node.data?.maxRetries || 3}
              onChange={(e) => onChange({ maxRetries: parseInt(e.target.value) })}
              className="w-full bg-bg-tertiary border border-border-subtle rounded px-3 py-2 text-text-primary"
              min={1}
              max={10}
            />
          </div>
        </div>
      );

    case 'fix':
      return (
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-2">Fix Actions</label>
            {['denoise', 'upscale', 'face_restore', 'hand_fix', 'interpolate'].map((action) => (
              <label key={action} className="flex items-center gap-2 py-1">
                <input
                  type="checkbox"
                  checked={(node.data?.actions || []).includes(action)}
                  onChange={(e) => {
                    const current = node.data?.actions || [];
                    if (e.target.checked) {
                      onChange({ actions: [...current, action] });
                    } else {
                      onChange({ actions: current.filter((a) => a !== action) });
                    }
                  }}
                  className="rounded"
                />
                <span className="text-text-primary text-sm capitalize">{action.replace('_', ' ')}</span>
              </label>
            ))}
          </div>
        </div>
      );

    case 'segment':
      return (
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Model</label>
            <select
              value={node.data?.model || 'sam'}
              onChange={(e) => onChange({ model: e.target.value })}
              className="w-full bg-bg-tertiary border border-border-subtle rounded px-3 py-2 text-text-primary"
            >
              <option value="sam">SAM (Segment Anything)</option>
              <option value="sam2">SAM 2</option>
              <option value="edge">Edge Detection</option>
            </select>
          </div>
          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={node.data?.trackMotion || false}
                onChange={(e) => onChange({ trackMotion: e.target.checked })}
                className="rounded"
              />
              <span className="text-text-primary text-sm">Track motion across frames</span>
            </label>
          </div>
        </div>
      );

    default:
      return (
        <div className="text-text-muted text-sm">
          No settings for this node type.
        </div>
      );
  }
};

// Wrap with Provider
const WorkflowDesigner = () => (
  <ReactFlowProvider>
    <WorkflowDesignerInner />
  </ReactFlowProvider>
);

export default WorkflowDesigner;
