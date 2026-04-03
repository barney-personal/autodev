import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { captureWithContext } from '../instrument.js';

interface PendingReply {
  resolve: (answer: string) => void;
  timer: NodeJS.Timeout;
}

let _instance: MessageRouter | null = null;

export function getMessageRouter(): MessageRouter {
  if (!_instance) _instance = new MessageRouter();
  return _instance;
}

class MessageRouter {
  private pending = new Map<string, PendingReply>();

  waitForAnswer(questionId: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.pending.delete(questionId);
          // Mark question timed out in DB
          queries.updateQuestion(questionId, { status: 'timeout', answer: '[TIMEOUT] No response received', answered_at: Date.now() });
          const q = queries.getQuestionById(questionId);
          if (q) socket.emitQuestionAnswered(q);
        } catch (err) {
          console.error(`[MessageRouter] error handling timeout for question ${questionId}:`, err);
          captureWithContext(err, { component: 'MessageRouter' });
        }
        resolve('[TIMEOUT] No response received');
      }, timeoutMs);

      this.pending.set(questionId, { resolve, timer });
    });
  }

  resolveReply(questionId: string, answer: string): boolean {
    const p = this.pending.get(questionId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(questionId);
    p.resolve(answer);
    return true;
  }

  hasPending(questionId: string): boolean {
    return this.pending.has(questionId);
  }
}
