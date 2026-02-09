import type { HttpRequest, HttpResponse } from './parser.js'

export type RouteParams = Record<string, string>
export type RouteHandler = (req: HttpRequest, params: RouteParams) => HttpResponse | Promise<HttpResponse>

interface Route {
  method: string
  segments: string[]  // e.g. ['api', 'inbox', ':id']
  wildcard: boolean   // ends with *
  handler: RouteHandler
}

export class Router {
  private routes: Route[] = []

  add(method: string, pattern: string, handler: RouteHandler): void {
    const segments = pattern.split('/').filter(Boolean)
    const wildcard = segments.length > 0 && segments[segments.length - 1] === '*'
    if (wildcard) segments.pop()

    this.routes.push({
      method: method.toUpperCase(),
      segments,
      wildcard,
      handler
    })
  }

  match(method: string, path: string): { handler: RouteHandler; params: RouteParams } | null {
    const pathSegments = path.split('/').filter(Boolean)
    const upperMethod = method.toUpperCase()

    for (const route of this.routes) {
      if (route.method !== upperMethod) continue

      const params = matchRoute(route, pathSegments)
      if (params !== null) {
        return { handler: route.handler, params }
      }
    }

    return null
  }
}

function matchRoute(route: Route, pathSegments: string[]): RouteParams | null {
  if (route.wildcard) {
    // Wildcard: path must have at least as many segments as route
    if (pathSegments.length < route.segments.length) return null
  } else {
    // Exact: segment count must match
    if (pathSegments.length !== route.segments.length) return null
  }

  const params: RouteParams = {}

  for (let i = 0; i < route.segments.length; i++) {
    const routeSeg = route.segments[i]!
    const pathSeg = pathSegments[i]!

    if (routeSeg.startsWith(':')) {
      params[routeSeg.slice(1)] = decodeURIComponent(pathSeg)
    } else if (routeSeg !== pathSeg) {
      return null
    }
  }

  if (route.wildcard) {
    params['*'] = pathSegments.slice(route.segments.length).map(decodeURIComponent).join('/')
  }

  return params
}
