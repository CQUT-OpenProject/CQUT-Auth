import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

const authorizationGenerations = new AsyncLocalStorage<Map<string, number>>();

export function withAuthorizationContext(
  _request: Request,
  _response: Response,
  next: NextFunction,
) {
  authorizationGenerations.run(new Map(), next);
}

export function captureAuthorizationGeneration(
  clientId: string,
  generation: number,
) {
  authorizationGenerations.getStore()?.set(clientId, generation);
}

export function currentAuthorizationGeneration(clientId: string) {
  return authorizationGenerations.getStore()?.get(clientId);
}
