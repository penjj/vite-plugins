import { isAbsolute, posix, parse, extname } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import globby from 'globby';
import getRouter, { Config as SirvConfig, HTTPVersion, HTTPMethod, RouteOptions, Handler } from 'find-my-way';
import { Plugin, ViteDevServer, send } from 'vite';
import sirv, { RequestHandler, Options as SirvOptions } from 'sirv';
import { OutgoingHttpHeaders } from 'http';

export interface HandleRoute {
  file?: string;
  handler?: any | Handler<HTTPVersion.V1>;
  options?: RouteOptions;
  store?: any;
}

export interface RouteConfig {
  [route: string]: string | Handler<HTTPVersion.V1> | HandleRoute;
}

export interface Options {
  cwd?: string;
  isAfter?: boolean;
  mockAssetsDir?: string;
  mockRouterOptions?: SirvConfig<HTTPVersion.V1> | SirvConfig<HTTPVersion.V2>;
  mockRoutes?: RouteConfig | RouteConfig[];
  mockRoutesDir?: string;
}


function isObject(val: any): boolean {
  return val && typeof val === 'object';
}

function toAbsolute(pth: string, cwd): string {
  return isAbsolute(pth)
    ? pth
    : posix.join(cwd || process.cwd(), pth);
}

function sirvOptions(headers?: OutgoingHttpHeaders): SirvOptions {
  return {
    dev: true,
    etag: true,
    extensions: [],
    setHeaders(res, pathname) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (/\.[tj]sx?$/.test(pathname)) {
        res.setHeader('Content-Type', 'application/javascript');
      }
      if (headers) {
        Object.entries(headers).forEach(([key, val]) => {
          if (val) {
            res.setHeader(key, val);
          }
        });
      }
    }
  };
}

function configureServer(
  server: ViteDevServer,
  routerOpts: SirvConfig<HTTPVersion.V1> | SirvConfig<HTTPVersion.V2> | undefined,
  routes: RouteConfig[],
  serve: RequestHandler | null,
  cwd: string
) {
  const router = getRouter(routerOpts);
  if (Array.isArray(routes)) {
    routes.forEach((route) => {
      Object.keys(route).forEach((xpath) => {
        let [methods, pathname] = xpath.split(' ');
        if (!pathname) {
          pathname = methods;
          methods = 'GET';
        }

        let routeConfig = route[xpath] as HandleRoute;
        if (!isObject(routeConfig)) {
          routeConfig = { handler: routeConfig };
        }

        let handler: Handler<HTTPVersion.V1> | undefined;
        let opts: RouteOptions | undefined;
        let store: any;

        if (typeof routeConfig.file === 'string') {
          handler = (req, res) => {
            const parsedPath = parse(toAbsolute(routeConfig.file as string, cwd));
            const serve = sirv(parsedPath.dir, sirvOptions(server.config.server.headers));
            req.url = `/${parsedPath.base}`;
            serve(req, res);
          };
        }
        else if (typeof routeConfig.handler !== 'function') {
          const ret = routeConfig.handler;
          const retType =  typeof ret;
          handler = (req, res) => {
            send(
              req,
              res,
              retType !== 'string' ? JSON.stringify(ret) : ret,
              isObject(ret) ? 'json' : 'html',
              {
                headers: server.config.server.headers
              }
            );
          };
        }
        else {
          handler = routeConfig.handler;
        }

        if (handler) {
          router.on(
            methods.split('/') as HTTPMethod[],
            pathname,
            opts || {},
            handler,
            store
          );
        }
      });
    });
  }

  if (serve) {
    server.middlewares.use(serve);
  }

  server.middlewares.use((req, res, next) => {
    (router as any).defaultRoute = () => next();
    router.lookup(req, res);
  });
}

export default function createPlugin(opts: Options): Plugin {
  const {
    isAfter,
    mockRouterOptions,
    mockAssetsDir
  } = opts;
  let {
    cwd,
    mockRoutesDir
  } = opts;

  let mockRoutes: RouteConfig[] = (opts.mockRoutes || []) as RouteConfig[];

  if (!cwd) {
    cwd = process.cwd();
  }

  if (isObject(mockRoutes) && !Array.isArray(mockRoutes)) {
    mockRoutes = [mockRoutes];
  }

  return {
    name: 'vite-plugin-mock-data',

    async configureServer(server: ViteDevServer) {
      if (mockRoutesDir) {
        mockRoutesDir = toAbsolute(mockRoutesDir, cwd);

        const paths = await globby(`${mockRoutesDir}/**/*.{js,mjs,json}`);
        console.log(paths);
        await Promise.all(paths.map((file) => {
          return (async () => {
            let config: RouteConfig | undefined;
            switch (extname(file)) {
              case '.js':
                config = createRequire(import.meta.url)(file);
                break;
              case '.mjs':
                config = (await import(file)).default;
                break;
              case '.json':
                config = JSON.parse(readFileSync(file, 'utf-8'));
                break;
            }
            if (config) {
              mockRoutes.push(config);
            }
          })();
        }));
      }

      let serve: RequestHandler | null = null;
      if (mockAssetsDir) {
        serve = sirv(
          toAbsolute(mockAssetsDir, cwd),
          sirvOptions(server.config.server.headers)
        );
      }

      return isAfter
        ? () => configureServer(server, mockRouterOptions, mockRoutes, serve, cwd as string)
        : configureServer(server, mockRouterOptions, mockRoutes, serve, cwd as string);
    }
  };
}
