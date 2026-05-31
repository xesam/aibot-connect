import type { AppContext, Middleware, Next } from '../types.js'

export function composeMiddleware<T extends AppContext>(
  middlewares: Middleware[],
  handler: (ctx: T) => Promise<void>,
): (ctx: T) => Promise<void> {
  return async (ctx: T): Promise<void> => {
    let index = -1

    const dispatch = async (middlewareIndex: number): Promise<void> => {
      if (middlewareIndex <= index) {
        throw new Error('next() called multiple times')
      }

      index = middlewareIndex

      const middleware = middlewares[middlewareIndex]
      if (!middleware) {
        await handler(ctx)
        return
      }

      const next: Next = () => dispatch(middlewareIndex + 1)
      await middleware(ctx, next)
    }

    await dispatch(0)
  }
}
