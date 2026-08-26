import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * v1 auth (SPEC.md §13.1): a manually issued device token, verified here.
 * Firebase phone OTP replaces this before any second user, which is why the
 * user id is resolved through a seam rather than assumed.
 */
declare global {
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Structured so requireRole() can be added later without a rewrite (§13.2). */
export function requireUser(env = process.env) {
  const token = env.DEVICE_TOKEN;
  const userId = env.DEVICE_USER_ID ?? 'primary';
  if (!token) throw new Error('DEVICE_TOKEN is not set');

  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!presented || !constantTimeEqual(presented, token)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.userId = userId;
    next();
  };
}
