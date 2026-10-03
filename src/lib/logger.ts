import pino from "pino";

const pretty = process.env.PRETTY_LOGS === "true";

export const logger = pino({
  level:
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV === "test" ? "silent" : "info"),
  ...(pretty && {
    transport: { target: "pino-pretty", options: { colorize: true } },
  }),
});
