import { Type } from 'typebox';

const errorSchema = Type.Object({
  error: Type.String(),
  errorCategory: Type.Optional(Type.String()),
  httpStatus: Type.Optional(Type.Integer()),
  truncated: Type.Boolean(),
  jobId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  state: Type.Optional(Type.String()),
  shots: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        state: Type.String(),
        taskId: Type.Optional(Type.String()),
      }),
    ),
  ),
});

export const videoJobOutputSchema = Type.Union([
  Type.Object({
    jobId: Type.String(),
    state: Type.Literal('done'),
    qcStatus: Type.Union([Type.Literal('not_performed'), Type.Literal('recorded')]),
    videoPath: Type.Optional(Type.String()),
    finalVideoPath: Type.Optional(Type.String()),
    bytes: Type.Optional(Type.Number()),
    taskId: Type.Optional(Type.String()),
    clipCount: Type.Optional(Type.Integer()),
    resumed: Type.Optional(Type.Boolean()),
    segments: Type.Optional(Type.Integer()),
    durationSec: Type.Optional(Type.Number()),
    subtitlePath: Type.Optional(Type.String()),
    qcFrames: Type.Optional(Type.Array(Type.String())),
    qcReportPath: Type.Optional(Type.String()),
    projectDir: Type.Optional(Type.String()),
    editableProjectDir: Type.Optional(Type.String()),
    shotsDone: Type.Optional(Type.Integer()),
    degraded: Type.Optional(Type.Array(Type.String())),
    truncated: Type.Boolean(),
  }),
  errorSchema,
]);

export const videoCapabilitiesOutputSchema = Type.Union([
  Type.Object({
    activeId: Type.String(),
    activeResolved: Type.Boolean(),
    totalModels: Type.Integer(),
    provider: Type.Optional(Type.String()),
    keyReady: Type.Optional(Type.Boolean()),
    capabilities: Type.Optional(
      Type.Object({
        durations: Type.Array(Type.Number()),
        resolutions: Type.Array(Type.String()),
        aspectRatios: Type.Array(Type.String()),
        nativeAudio: Type.Boolean(),
        supportsFirstLastFrame: Type.Boolean(),
        maxReferenceImages: Type.Number(),
        maxReferenceVideos: Type.Optional(Type.Number()),
        maxReferenceAudios: Type.Optional(Type.Number()),
        referenceAssetModalities: Type.Optional(Type.Array(Type.String())),
      }),
    ),
    models: Type.Array(
      Type.Object({
        id: Type.String(),
        aliases: Type.Array(Type.String()),
        provider: Type.String(),
        keyReady: Type.Boolean(),
      }),
    ),
    truncated: Type.Boolean(),
  }),
  errorSchema,
]);
