/** Everything this app reads from the environment, with defaults that work inside compose. */
export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://faces:faces@db:5432/gallery",
  pipelineUrl: process.env.PIPELINE_URL ?? "http://api:8080",
  // Where the pipeline posts results. It calls us from inside the Docker network.
  callbackUrl: process.env.CALLBACK_URL ?? "http://frontend:3000/api/webhooks/faces",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "dev-secret",
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? "http://minio:9000",
    bucket: process.env.S3_BUCKET ?? "faces",
    accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
    secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
    region: process.env.S3_REGION ?? "us-east-1",
  },
  // Cosine similarity, same meaning as the pipeline's thresholds but applied here, where the vectors live.
  sameFace: Number(process.env.SAME_FACE ?? 0.45), // a strong face joins a person above this
  attachFace: Number(process.env.ATTACH_FACE ?? 0.5), // weak faces need to be closer, and never start a person
  // Starting a new person is stricter than joining one. A face turned further than this can join
  // someone it matches, but never becomes a person of its own: that is what turned one man's
  // profile shot into a second person.
  createMaxYaw: Number(process.env.CREATE_MAX_YAW ?? 0.35),
  // A face is also allowed to join someone it is *clearly* closest to, even below sameFace.
  // Measured on a library of four people plus a video of three of them: the right person scored
  // 0.14 to 0.77 while the closest wrong person never passed 0.17. A blurred video face reached
  // only 0.39 against its own photos, below the 0.45 bar, but the runner-up was 0.10 — so who it
  // is was never in doubt. These two numbers say "far enough ahead of everyone else to be sure".
  matchFloor: Number(process.env.MATCH_FLOOR ?? 0.35),
  matchMargin: Number(process.env.MATCH_MARGIN ?? 0.2),
  // How many already-grouped faces to look at when working out who a new face is closest to.
  matchNeighbours: Number(process.env.MATCH_NEIGHBOURS ?? 40),
  // On a person's page, other people this close are offered as "might also be this person".
  suggestFrom: Number(process.env.SUGGEST_FROM ?? 0.25),
};
