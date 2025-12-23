import React, { useMemo } from 'react';
import clsx from 'clsx';

/**
 * TokenFlow - Visualizes the token sequence and generation progress
 *
 * Shows each token with its position and highlights the current token being processed.
 * Can display log probabilities when available.
 */
const TokenFlow = ({
  tokens = [],
  currentPosition = -1,
  promptLength = 0,
  showLogProbs = false,
  onTokenClick,
  className
}) => {
  // Group tokens into prompt and generated
  const { promptTokens, generatedTokens } = useMemo(() => {
    const prompt = tokens.slice(0, promptLength);
    const generated = tokens.slice(promptLength);
    return { promptTokens: prompt, generatedTokens: generated };
  }, [tokens, promptLength]);

  const getTokenColor = (token, index) => {
    const isPrompt = index < promptLength;
    const isCurrent = index === currentPosition;

    if (isCurrent) {
      return 'bg-text-accent text-bg-primary';
    }
    if (isPrompt) {
      return 'bg-cluster-spark/20 text-cluster-spark border-cluster-spark/30';
    }
    return 'bg-status-online/20 text-status-online border-status-online/30';
  };

  const getLogProbColor = (logprob) => {
    if (logprob === undefined || logprob === null) return 'text-text-muted';
    const prob = Math.exp(logprob);
    if (prob > 0.8) return 'text-status-online';
    if (prob > 0.5) return 'text-yellow-400';
    if (prob > 0.2) return 'text-orange-400';
    return 'text-status-error';
  };

  return (
    <div className={clsx('flex flex-col gap-4', className)}>
      {/* Prompt Tokens */}
      {promptTokens.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wider">
            Prompt ({promptTokens.length} tokens)
          </h4>
          <div className="flex flex-wrap gap-1">
            {promptTokens.map((token, idx) => (
              <TokenChip
                key={`prompt-${idx}`}
                token={token}
                index={idx}
                isCurrent={idx === currentPosition}
                isPrompt={true}
                showLogProbs={showLogProbs}
                onClick={() => onTokenClick?.(token, idx)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Generated Tokens */}
      {generatedTokens.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wider">
            Generated ({generatedTokens.length} tokens)
          </h4>
          <div className="flex flex-wrap gap-1">
            {generatedTokens.map((token, idx) => {
              const globalIdx = promptLength + idx;
              return (
                <TokenChip
                  key={`gen-${idx}`}
                  token={token}
                  index={globalIdx}
                  isCurrent={globalIdx === currentPosition}
                  isPrompt={false}
                  showLogProbs={showLogProbs}
                  onClick={() => onTokenClick?.(token, globalIdx)}
                />
              );
            })}
          </div>
        </div>
      )}

      {tokens.length === 0 && (
        <div className="text-center text-text-muted py-8">
          <p className="text-sm">No tokens to display</p>
          <p className="text-xs mt-1">Tokens will appear as the model generates</p>
        </div>
      )}
    </div>
  );
};

const TokenChip = ({ token, index, isCurrent, isPrompt, showLogProbs, onClick }) => {
  const displayText = token.token.replace(/\n/g, '↵').replace(/\t/g, '→');
  const isWhitespace = /^\s+$/.test(token.token);

  return (
    <button
      onClick={onClick}
      className={clsx(
        'group relative px-2 py-1 rounded text-xs font-mono border transition-all',
        isCurrent && 'ring-2 ring-text-accent ring-offset-1 ring-offset-bg-primary',
        isPrompt
          ? 'bg-cluster-spark/10 text-cluster-spark border-cluster-spark/20 hover:bg-cluster-spark/20'
          : 'bg-status-online/10 text-status-online border-status-online/20 hover:bg-status-online/20',
        isWhitespace && 'italic text-text-muted'
      )}
      title={`Token ${index}: "${token.token}" (ID: ${token.token_id})`}
    >
      {isWhitespace ? '␣' : displayText}

      {/* Log probability indicator */}
      {showLogProbs && token.logprob !== undefined && (
        <span className={clsx(
          'ml-1 text-[10px]',
          token.logprob > -0.5 ? 'text-status-online' :
            token.logprob > -2 ? 'text-yellow-400' : 'text-status-error'
        )}>
          {(Math.exp(token.logprob) * 100).toFixed(0)}%
        </span>
      )}

      {/* Hover tooltip */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-bg-tertiary border border-border-default rounded text-[10px] whitespace-nowrap opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
        <div>Position: {index}</div>
        <div>Token ID: {token.token_id}</div>
        {token.logprob !== undefined && (
          <div>Prob: {(Math.exp(token.logprob) * 100).toFixed(1)}%</div>
        )}
      </div>
    </button>
  );
};

export default TokenFlow;
