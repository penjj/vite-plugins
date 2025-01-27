import { extname, isAbsolute, posix, parse } from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import globby from 'globby';
import getRouter from 'find-my-way';
import { send } from 'vite';
import sirv from 'sirv';

function isObject(val) {
    return val && typeof val === 'object';
}
function toAbsolute(pth, cwd) {
    return isAbsolute(pth)
        ? pth
        : posix.join(cwd || process.cwd(), pth);
}
function sirvOptions(headers) {
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
function configureServer(server, routerOpts, routes, serve, cwd) {
    const router = getRouter(routerOpts);
    if (Array.isArray(routes)) {
        routes.forEach((route) => {
            Object.keys(route).forEach((xpath) => {
                let [methods, pathname] = xpath.split(' ');
                if (!pathname) {
                    pathname = methods;
                    methods = 'GET';
                }
                let routeConfig = route[xpath];
                if (!isObject(routeConfig)) {
                    routeConfig = { handler: routeConfig };
                }
                let handler;
                let store;
                if (typeof routeConfig.file === 'string') {
                    handler = (req, res) => {
                        const parsedPath = parse(toAbsolute(routeConfig.file, cwd));
                        const serve = sirv(parsedPath.dir, sirvOptions(server.config.server.headers));
                        req.url = `/${parsedPath.base}`;
                        serve(req, res);
                    };
                }
                else if (typeof routeConfig.handler !== 'function') {
                    const ret = routeConfig.handler;
                    const retType = typeof ret;
                    handler = (req, res) => {
                        send(req, res, retType !== 'string' ? JSON.stringify(ret) : ret, isObject(ret) ? 'json' : 'html', {
                            headers: server.config.server.headers
                        });
                    };
                }
                else {
                    handler = routeConfig.handler;
                }
                if (handler) {
                    router.on(methods.split('/'), pathname, {}, handler, store);
                }
            });
        });
    }
    if (serve) {
        server.middlewares.use(serve);
    }
    server.middlewares.use((req, res, next) => {
        router.defaultRoute = () => next();
        router.lookup(req, res);
    });
}
function createPlugin(opts) {
    const { isAfter, mockRouterOptions, mockAssetsDir } = opts;
    let { cwd, mockRoutesDir } = opts;
    let mockRoutes = (opts.mockRoutes || []);
    if (!cwd) {
        cwd = process.cwd();
    }
    if (isObject(mockRoutes) && !Array.isArray(mockRoutes)) {
        mockRoutes = [mockRoutes];
    }
    return {
        name: 'vite-plugin-mock-data',
        async configureServer(server) {
            if (mockRoutesDir) {
                mockRoutesDir = toAbsolute(mockRoutesDir, cwd);
                const paths = await globby(`${mockRoutesDir}/**/*.{js,mjs,json}`);
                console.log(paths);
                await Promise.all(paths.map((file) => {
                    return (async () => {
                        let config;
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
            let serve = null;
            if (mockAssetsDir) {
                serve = sirv(toAbsolute(mockAssetsDir, cwd), sirvOptions(server.config.server.headers));
            }
            return isAfter
                ? () => configureServer(server, mockRouterOptions, mockRoutes, serve, cwd)
                : configureServer(server, mockRouterOptions, mockRoutes, serve, cwd);
        }
    };
}

export { createPlugin as default };
