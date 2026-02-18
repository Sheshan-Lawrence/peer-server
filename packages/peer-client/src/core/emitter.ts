export type ErrorHandler = (error: unknown, event: string) => void;

let globalErrorHandler: ErrorHandler = (error, event) => {
  if (error instanceof Error) {
    console.error(
      `[Emitter] "${event}" → ${error.message}\n${error.stack ?? ''}`
    );
  } else {
    console.error(`[Emitter] "${event}" →`, error);
  }
};


export function setEmitterErrorHandler(handler: ErrorHandler): void {
  globalErrorHandler = handler;
}

export class Emitter<Events extends string = string> {
  private listeners = new Map<Events, Set<(...args: any[]) => void>>();

  on(event: Events, fn: (...args: any[]) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.off(event, fn);
  }

  once(event: Events, fn: (...args: any[]) => void): () => void {
    const wrapper = (...args: any[]) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: Events, fn: (...args: any[]) => void): void {
    this.listeners.get(event)?.delete(fn);
  }

  emit(event: Events, ...args: any[]): void {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {
        globalErrorHandler(e, event);
      }
    });
  }

  listenerCount(event: Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAllListeners(event?: Events): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}