import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import elementsRouter from './routes/elements.js';
import uploadsRouter from './routes/uploads.js';
import templatesRouter from './routes/templates.js';
import tagsRouter from './routes/tags.js';
import storageRouter from './routes/storage.js';
import bakersRouter from './routes/bakers.js';
import ordersRouter from './routes/orders.js';
import customersRouter from './routes/customers.js';
import dashboardRouter from './routes/dashboard.js';
import billingRouter from './routes/billing.js';
import subscriptionsRouter from './routes/subscriptions.js';
import craftGuideRouter from './routes/craftGuide.js';
import nozzlesRouter from './routes/nozzles.js';
import rbacRouter from './routes/rbac.js';
import storefrontRouter from './routes/storefront.js';
import meshyRouter from './routes/meshy.js';
import webhooksRouter from './routes/webhooks.js';
import inspirationRouter from './routes/inspiration.js';
import elementExtractRouter from './routes/elementExtract.js';
import texturesRouter from './routes/textures.js';
import textStylesRouter from './routes/textStyles.js';
import cakeShapesRouter from './routes/cakeShapes.js';
import materialsRouter from './routes/materials.js';
import legalRouter from './routes/legal.js';
import accountRouter from './routes/account.js';
import designSessionsRouter from './routes/designSessions.js';
import aiCreditsRouter from './routes/aiCredits.js';
import designEstimateRouter from './routes/designEstimate.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requireAuth } from './middleware/auth.js';
import { requireAdmin } from './middleware/rbac.js';
import { corsOptions } from './lib/cors.js';

const app = express();

// Render (and any managed host) terminates TLS at a proxy and forwards the real client IP in
// X-Forwarded-For. Trust exactly ONE hop so `req.ip` is the actual client — required for correct
// per-IP rate limiting (SEC-4); without this every request would look like the proxy's single IP.
app.set('trust proxy', 1);

app.use(cors(corsOptions()));   // SEC-8: allowlist our own origins, not `*`
app.use(requestId);   // correlation id on every request — must run first

// Webhooks need the raw body (signature verification / unsigned-but-verified-by-refetch) —
// mount before express.json() so the body isn't consumed as JSON first.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.post('/api/webhooks/meshy',  express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '5mb' }));

// ADMIN BOUNDARY (SEC-0a): every `/api/admin/*` route is gated here, at the mount, before the
// routers that define them — so an admin route can NEVER be exposed by forgetting a per-route guard.
// requireAdmin = an internal admin principal (a row in `admins`), not merely an admin capability.
// Per-route requireCapability(...) still applies on top for finer-grained grants. Keep privileged
// routes under `/api/admin` so this backstop covers them (enforced by `npm run check:admin-routes`).
app.use('/api/admin', requireAuth, requireAdmin);

app.use(healthRouter);
app.use('/api', elementsRouter);
app.use('/api', uploadsRouter);       // uploads: baker/customer-owned images (NOT /api/admin)
app.use('/api', templatesRouter);
app.use('/api', tagsRouter);
app.use('/api', storageRouter);
app.use('/api', bakersRouter);
app.use('/api', ordersRouter);
app.use('/api', customersRouter);
app.use('/api', dashboardRouter);
app.use('/api', billingRouter);
app.use('/api', subscriptionsRouter);
app.use('/api', craftGuideRouter);
app.use('/api', nozzlesRouter);
app.use('/api', rbacRouter);
app.use('/api', storefrontRouter);
app.use('/api', meshyRouter);
app.use('/api', webhooksRouter);
app.use('/api', inspirationRouter);
app.use('/api', elementExtractRouter);
app.use('/api', texturesRouter);
app.use('/api', textStylesRouter);
app.use('/api', cakeShapesRouter);
app.use('/api', materialsRouter);
app.use('/api', legalRouter);
app.use('/api', accountRouter);
app.use('/api', designSessionsRouter);
app.use('/api', aiCreditsRouter);
app.use('/api', designEstimateRouter);

app.use(errorHandler);   // global safety net — must run last, after all routers

export default app;
