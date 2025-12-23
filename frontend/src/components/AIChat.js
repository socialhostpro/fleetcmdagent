import React, { useState, useRef, useEffect } from 'react';
import { Bot, Send, X, Maximize2, Minimize2, RefreshCw, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import clsx from 'clsx';

const API_URL = `http://${window.location.hostname}:8765/api`;

const AIChat = ({ isOpen, onClose, initialPrompt }) => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('llama3.1:8b');
  const messagesEndRef = useRef(null);

  useEffect(() => {
    // Fetch available models
    fetch(`${API_URL}/ai/models`)
      .then(res => res.json())
      .then(data => {
        setModels(data.models || []);
        if (data.default) setSelectedModel(data.default);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    // Add initial prompt if provided
    if (initialPrompt && isOpen) {
      handleSend(initialPrompt);
    }
  }, [initialPrompt, isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async (messageText = input) => {
    if (!messageText.trim() || isLoading) return;

    const userMessage = { role: 'user', content: messageText };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch(`${API_URL}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: messageText,
          context: 'fleet',
          include_fleet_status: true,
          model: selectedModel
        })
      });

      if (!response.ok) throw new Error('AI request failed');

      const data = await response.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
    } catch (error) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${error.message}. Please try again.`,
        isError: true
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAnalyze = async () => {
    setIsLoading(true);
    setMessages(prev => [...prev, { role: 'user', content: 'Analyze the current fleet status' }]);

    try {
      const response = await fetch(`${API_URL}/ai/analyze`);
      const data = await response.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.analysis }]);
    } catch (error) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Failed to analyze fleet. Please try again.',
        isError: true
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const clearChat = () => {
    setMessages([]);
  };

  if (!isOpen) return null;

  return (
    <div
      className={clsx(
        'fixed z-50 bg-bg-secondary border border-border-subtle rounded-lg shadow-2xl flex flex-col transition-all duration-300',
        isExpanded
          ? 'inset-4'
          : 'bottom-4 right-4 w-96 h-[600px]'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border-subtle bg-bg-tertiary rounded-t-lg">
        <div className="flex items-center gap-2">
          <Bot className="text-text-accent" size={20} />
          <span className="font-semibold text-text-primary">Fleet Commander AI</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleAnalyze}
            disabled={isLoading}
            className="p-1.5 rounded hover:bg-bg-hover text-text-secondary hover:text-text-accent transition-colors"
            title="Analyze Fleet"
          >
            <Sparkles size={16} />
          </button>
          <button
            onClick={clearChat}
            className="p-1.5 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
            title="Clear Chat"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
            title={isExpanded ? 'Minimize' : 'Maximize'}
          >
            {isExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Model Selector */}
      <div className="px-3 py-2 border-b border-border-subtle bg-bg-tertiary/50">
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          className="w-full bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-xs text-text-primary"
        >
          {models.map(m => (
            <option key={m.name} value={m.name}>
              {m.name} ({(m.size / 1e9).toFixed(1)}GB)
            </option>
          ))}
        </select>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-text-muted py-8">
            <Bot size={40} className="mx-auto mb-3 opacity-50" />
            <p className="text-sm">Ask me about your fleet!</p>
            <p className="text-xs mt-1">I can analyze status, troubleshoot issues, and help manage clusters.</p>
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
              {['Analyze fleet health', 'Show cluster status', 'Any nodes with issues?'].map(q => (
                <button
                  key={q}
                  onClick={() => handleSend(q)}
                  className="text-xs px-2 py-1 bg-bg-tertiary hover:bg-bg-hover rounded border border-border-subtle text-text-secondary hover:text-text-primary transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={clsx(
              'max-w-[85%] rounded-lg p-3',
              msg.role === 'user'
                ? 'ml-auto bg-text-accent/20 text-text-primary'
                : msg.isError
                  ? 'bg-status-error/10 text-status-error'
                  : 'bg-bg-tertiary text-text-primary'
            )}
          >
            {msg.role === 'assistant' ? (
              <div className="prose prose-sm prose-invert max-w-none">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm">{msg.content}</p>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="bg-bg-tertiary rounded-lg p-3 max-w-[85%]">
            <div className="flex items-center gap-2 text-text-muted">
              <div className="animate-spin">
                <RefreshCw size={14} />
              </div>
              <span className="text-sm">Thinking...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border-subtle">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask about your fleet..."
            disabled={isLoading}
            className="flex-1 bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-text-accent disabled:opacity-50"
          />
          <button
            onClick={() => handleSend()}
            disabled={isLoading || !input.trim()}
            className="p-2 bg-text-accent hover:bg-text-accent/80 disabled:bg-bg-tertiary disabled:text-text-muted rounded-lg transition-colors"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default AIChat;
