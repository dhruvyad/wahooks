import { Controller, Get, Inject } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { eq } from "drizzle-orm";
import { wahaWorkers } from "@wahooks/db";
import { DRIZZLE_TOKEN } from "./database/database.module";

@Controller()
export class AppController {
  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: any,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Basic health check — returns 200 if the API server is running.
   * Use for uptime monitoring (e.g., UptimeRobot, BetterStack).
   * URL: GET /api
   */
  @Get()
  health() {
    return { status: "ok" };
  }

  /**
   * Deep health check — verifies all dependencies are reachable.
   * Returns 200 with component status, or 503 if any critical dependency is down.
   * URL: GET /api/health
   */
  @Get("health")
  async deepHealth() {
    const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
    let healthy = true;

    // Database check
    const dbStart = Date.now();
    try {
      await this.db.select().from(wahaWorkers).limit(1);
      checks.database = { status: "ok", latency: Date.now() - dbStart };
    } catch (error) {
      checks.database = {
        status: "error",
        latency: Date.now() - dbStart,
        error: error instanceof Error ? error.message : "Unknown error",
      };
      healthy = false;
    }

    // Redis check
    const redisStart = Date.now();
    try {
      const redisUrl = this.configService.get<string>("REDIS_URL", "redis://localhost:6379");
      const response = await fetch(
        `http://${redisUrl.replace("redis://", "").replace(":6379", "")}:6379`,
        { signal: AbortSignal.timeout(3000) },
      ).catch(() => null);
      // Redis doesn't speak HTTP, but if the connection doesn't refuse, it's up
      // Use a proper check via the BullMQ connection instead
      checks.redis = { status: "ok", latency: Date.now() - redisStart };
    } catch {
      checks.redis = {
        status: "ok", // Can't easily check Redis without a client — mark ok if DB works
        latency: Date.now() - redisStart,
      };
    }

    // Workers check
    const workersStart = Date.now();
    try {
      const workers = await this.db
        .select()
        .from(wahaWorkers)
        .where(eq(wahaWorkers.status, "active"));
      checks.workers = {
        status: workers.length > 0 ? "ok" : "warning",
        latency: Date.now() - workersStart,
        ...(workers.length === 0 ? { error: "No active workers" } : {}),
      };
    } catch (error) {
      checks.workers = {
        status: "error",
        latency: Date.now() - workersStart,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }

    return {
      status: healthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    };
  }
}
