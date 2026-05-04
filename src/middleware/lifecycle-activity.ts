import type { Request, Response, NextFunction } from 'express';
import type { LifecycleController } from '../services/lifecycle-controller';

/**
 * Lifecycle activity middleware - tracks request start/end.
 * Must be passive and non-blocking; missing controller is a no-op.
 * Bypasses /health to avoid impacting readiness probes.
 */
export function createLifecycleActivityMiddleware(controller: LifecycleController) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Bypass /health to avoid impacting readiness probes
    if (req.path === '/health') {
      return next();
    }
    controller.recordRequestStart();
    res.on('finish', () => controller.recordRequestEnd());
    res.on('close', () => controller.recordRequestEnd());
    next();
  };
}
