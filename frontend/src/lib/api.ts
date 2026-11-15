// 127.0.0.1 rather than "localhost": on Windows "localhost" may try IPv6 first and stall ~2s per new connection.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

export const fileUrl = (path: string | null | undefined) => (path ? `${API_URL}${path}` : "");

// ---------- types ----------

export type LabelClass = { id: number; name: string; color: string; box_count: number };

export type Geometry = { x: number; y: number; w: number; h: number };

export type Box = Geometry & { id: number; class_id: number; source: string };

/** Coarse confidence word; never shown as a raw percentage (it is not a calibrated probability). */
export type ConfidenceLevel = "sure" | "fair" | "unsure";

/** How often Pixel's recent guesses of a given level were right, as judged by you. */
export type Track = { right: number; total: number };

export type Proposal = Geometry & {
  id: number;
  region_id: number;
  class_id: number;
  second_class_id: number | null;
  confidence: number;
  margin: number;
  nn_sim: number;
  level: ConfidenceLevel;
  track: Track | null;
  /** only when Pixel uses the trained detector: what it saw here (class_id null = nothing); score is its own, uncalibrated */
  detector?: { class_id: number | null; score: number };
};

export type ImageStatus = "pending" | "embedded" | "annotated" | "ignored" | "error";

export type ImageSummary = {
  id: number;
  filename: string;
  url: string;
  thumb_url: string;
  width: number;
  height: number;
  status: ImageStatus;
  box_count: number;
};

export type ImageDetail = ImageSummary & {
  boxes: Box[];
  proposals: Proposal[];
  verified: boolean;
  /** Pixel's honest sentence about its top guess, backed by its track record */
  track_line: string | null;
};

export type LearningCurve = { total: number; block: number; first: Track; recent: Track };

export type SimilarImage = {
  image_id: number;
  similarity: number;
  thumb_url: string;
  status: ImageStatus;
  box_count: number;
  classes: number[];
};

/** The background analysis (segmentation + embeddings), see backend worker.py. */
export type WorkerProgress = {
  running: boolean;
  phase: "idle" | "loading" | "boxes" | "scanning" | "detector" | "learning";
  kind: "new" | "rescan" | "mixed" | null;
  done: number;
  total: number;
  seconds_per_image: number | null;
  eta_s: number | null;
  started_at: number | null;
  model_ready: boolean;
  error: string | null;
  last: { count: number; kind: string; finished_at: number; seconds: number } | null;
};

export type Stats = {
  images: Record<ImageStatus | "total", number>;
  classes: LabelClass[];
  boxes: number;
  proposals: number;
  batch_ready: number;
  gestures: number;
  propagated: number;
  verified: number;
  track: Record<ConfidenceLevel, Track>;
  learning: LearningCurve | null;
  worker: WorkerProgress;
  engine: {
    profile: ProfileName; embedder: string; model: string; device: string; segmenter_device: string;
    faiss: boolean; vectors: number; runtime: RuntimeInfo;
    segmenter: string; proposer: string; probe: ProbeInfo | null;
  };
  /** Pixel's judged guesses stopped improving: it proposes a dedicated detector (real numbers only) */
  suggestion: {
    kind: "train_detector"; errors: number[]; block: number; judged: number;
    ready: boolean; finished_images: number; min_images: number; trained_before: boolean;
  } | null;
  /** the project's active detector as extra evidence for Pixel (null = no active detector) */
  detector: DetectorState | null;
  pixel_message: string;
};

export type DetectorState = {
  run: string; used: boolean; scanned: number; todo: number; boxes: number; regions: number;
};

export type BoxInput = Geometry & {
  id?: number;
  class_id: number;
  proposal_region_id?: number | null;
  proposal_class_id?: number | null;
};

export type RejectedInput = Geometry & { region_id: number; class_id: number };

export type SaveResult = { delta_count: number; status: ImageStatus; message: string };

export type SegmentResult = { box: Geometry | null; score: number; segmenter: string };

export type BatchItem = Geometry & {
  proposal_id: number;
  region_id: number;
  image_id: number;
  thumb_url: string;
  class_id: number;
  confidence: number;
  level: ConfidenceLevel;
};

export type BatchGroup = { id: number; title: string; total: number; items: BatchItem[] };

export type BatchResponse = { groups: BatchGroup[]; total: number; message: string };

export type ReviewItem = { proposal_id: number; region_id: number; class_id: number; from_class_id?: number | null };

export type ReviewResult = {
  accepted: number;
  rejected: number;
  corrected: number;
  controls_found: number;
  controls_missed: number;
  delta_count: number;
  message: string;
};

export type Thumb = { image_id: number; thumb_url: string };

export type ConfusionItem = Geometry & {
  region_id: number;
  image_id: number;
  thumb_url: string | null;
  proposed_class_id: number;
  confidence: number;
};

export type Question =
  | { id: number; type: "few_examples"; text: string; status: string;
      payload: { class_id: number; class_name: string; count: number; image_ids: number[]; samples: Thumb[] } }
  | { id: number; type: "novelty"; text: string; status: string;
      payload: { count: number; image_ids: number[]; samples: Thumb[] } }
  | { id: number; type: "confusion"; text: string; status: string;
      payload: { class_a: number; class_b: number; name_a: string; name_b: string; items: ConfusionItem[] } };

export type AnswerResult = { message: string; queue: number[]; delta_count: number };

export type EngineSettings = {
  sim_min: number;
  sim_high: number;
  auto_calibrate: boolean;
  propose_min: number;
  batch_min: number;
  knn_k: number;
  temperature: number;
  max_per_image: number;
  use_probe: boolean;
  /** which learner next to the kNN memory (a registered probe: linear | mlp | a plugin's) */
  probe: string;
  probe_weight: number;
  probe_ramp: number;
  use_background: boolean;
  snap_boxes: boolean;
  use_detector: boolean;
  detector_weight: number;
  detector_veto: number;
};

export type ProbeInfo = {
  /** which learner (a registered probe id) */
  kind?: string;
  examples: number;
  classes: number;
  background: boolean;
  train_acc: number;
  weight: number;
  steps: number;
  sources: { boxes: number; matched: number; parts: number; groups: number; clutter: number; verified: number; background: number };
};

// ---------- exports ----------

export type ExportFormat = "coco" | "yolo" | "voc" | "csv" | "masks";

export type ExportJob = {
  id: string;
  project_name: string;
  options: { formats: ExportFormat[]; masks: boolean; images: boolean; scope: string; split: [number, number, number] };
  status: "queued" | "running" | "done" | "error" | "cancelled";
  phase: "queued" | "masks" | "writing" | "done";
  done: number;
  total: number;
  eta_s: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  size: number;
  counts: {
    images?: number; boxes?: number; classes?: number; negatives?: number; splits?: Record<string, number>;
    masks_segmenter?: number; masks_box_fallback?: number;
  };
};

export type ExportInfo = {
  formats: Record<ExportFormat, string>;
  candidates: { annotated: number; boxed: number; boxes: number; cached_masks: number };
  jobs: ExportJob[];
};

export type ExportRequest = {
  formats: ExportFormat[]; masks: boolean; images: boolean; scope: "annotated" | "boxed";
  train: number; val: number; test: number;
};

// ---------- projects ----------

export type PixelShape = "round" | "square" | "blob" | "tall";

/** What makes each project's Pixel unique. */
export type PixelTraits = { name: string; color: string; shape: PixelShape; eyes: string; accessory: string };

export type Accent = { light: string; dark: string };

export type Project = {
  id: string;
  name: string;
  created_at: string;
  pixel: PixelTraits;
  accent: Accent;
  stats: { images: number; boxes: number; classes: number };
  active: boolean;
};

export type PixelOptions = {
  colors: Record<string, Accent>;
  shapes: PixelShape[];
  eyes: string[];
  accessories: string[];
  names: string[];
};

export type ProjectList = { active: string | null; projects: Project[]; pixel_options: PixelOptions };

/** built-in "light" | "balanced" | "accurate", "custom" (any registered components), or a plugin's profile */
export type ProfileName = string;

/** A registered component (backend plugins.py): embedder, segmenter or probe. */
export type EngineComponent = {
  id: string; title: string; summary: string; license: string;
  models: { id: string; title: string; license: string; note: string }[];
  default_model: string; needs_torch: boolean; custom_model: boolean; builtin: boolean; available: boolean;
};

export type CustomEngine = {
  embedder: string; model: string; segmenter: string; sam_model: string; sam_points: number; sam_refine: number;
};

export type EngineProfile = {
  profile: ProfileName;
  title: string;
  summary: string;
  embedder: string;
  model: string;
  segmenter: string;
  sam_model: string;
  sam_points: number;
  sam_refine: number;
  signature: string;
};

/** How the vision models are executed (ONNX Runtime + execution provider, or the PyTorch fallback). */
export type RuntimeInfo = {
  runtime: "onnx" | "torch"; requested_runtime: string; requested_ep: string;
  provider: string | null; gpu: boolean; available: string[]; fallbacks: Record<string, string>;
};

export type EngineInfo = {
  active: EngineProfile; profiles: EngineProfile[]; overrides: string[]; runtime: RuntimeInfo;
  components: {
    embedders: EngineComponent[]; segmenters: EngineComponent[]; probes: EngineComponent[];
    plugins: string[]; errors: { plugin: string; error: string }[]; plugins_dir: string;
  };
};

export type SettingsResponse = {
  settings: EngineSettings;
  effective: {
    sim_min: number; sim_high: number; calibrated: boolean;
    profile: { same: number; other: number } | null;
    probe: ProbeInfo | null;
  };
};

// ---------- detector training (LibreYOLO) ----------

export type DetectorModel = {
  id: string; title: string; family: string; family_id: string; size: string; weights: string; license: string; summary: string;
  /** "CNN" | "transformer": transformers want more images and time */
  kind: string; family_summary?: string; builtin?: boolean;
  /** this family trains and exports only at this image size */
  fixed_imgsz?: number | null;
};

export type TrainingDataset = {
  images: number; train: number; val: number; background: number; boxes: number;
  classes: Record<string, number>; ready: boolean; reasons: string[]; min_images: number;
};

export type TrainingEpoch = { epoch: number; loss: number; seconds: number; map50: number | null; map50_95: number | null };

export type TrainingRun = {
  id: string; model: string; epochs: number; imgsz: number; patience: number; batch: number; created_at: string;
  dataset: { classes: string[]; images: number; train: number; val: number; boxes: number };
  state: "preparing" | "running" | "done" | "stopped" | "interrupted" | "failed";
  phase?: string | null; device?: string; epoch?: number; total_epochs?: number; eta_s?: number | null;
  history: TrainingEpoch[]; best?: { epoch: number; map50: number | null; map50_95: number | null } | null;
  error?: string | null; export_error?: string | null; stopped_early?: boolean; completed_epochs?: number;
  started_at?: number; finished_at?: number;
  model_info: Partial<DetectorModel>; has_model: boolean; has_onnx: boolean; resumable: boolean;
};

export type TrainingInfo = {
  available: boolean; unavailable_reason: string | null; device: string | null;
  models: DetectorModel[]; dataset: TrainingDataset; runs: TrainingRun[]; busy: { project: string; id: string } | null;
  /** trainable LibreYOLO detection families Kweeto does not offer (yet): their license must be checked first */
  more_families: { family: string; sizes: string[]; group: string; prefix: string }[];
  /** the project's active detector (shown next to Pixel's guesses) */
  active: string | null;
};

/** A box of the trained detector. `score` is its own, uncalibrated: never show it as a percentage. */
export type Detection = Geometry & { class_id: number; class_name: string; score: number };
export type DetectorView = { run: string | null; provider?: string; ms?: number; boxes: Detection[] };

// ---------- import of existing datasets ----------

export type ImportFormat = "coco" | "yolo" | "voc" | "labelstudio" | "cvat";

export type ImportJob = {
  id: string; status: "staging" | "running" | "done" | "error" | "cancelled";
  done: number; total: number; error: string | null; format: ImportFormat | null; message: string | null;
  counts: {
    images?: number; duplicates?: number; rejected?: number; boxes?: number; annotated?: number; finished?: number;
    kept_yours?: number; outside?: number; skipped_class?: number; classes_new?: number;
  };
};

export type ImportPreview = {
  format: ImportFormat | null;
  formats: Partial<Record<ImportFormat, { title: string; images: number; boxes: number }>>;
  files: number; images_uploaded: number;
  /** annotations matched to an image (uploaded now or already in the project) */
  annotated: number; with_boxes: number; listed_empty: number; in_project: number;
  /** uploaded images that are already in the project (same content) */
  already_here: number;
  /** images of the project that already have your boxes: they keep them */
  keeps_boxes: number;
  /** uploaded images no annotation mentions: imported as images still to teach */
  unlabelled: number;
  missing: number; missing_examples: string[];
  boxes: number;
  classes: { name: string; boxes: number; images: number; existing: string | null }[];
  project_images: number; warnings: string[];
  job: ImportJob;
};

// ---------- dataset health ----------

export type HealthImage = { id: number; filename: string; url: string; thumb_url: string; width: number; height: number; status: ImageStatus };

export type HealthBox = Geometry & { box_id: number; class_id: number; image: HealthImage };

export type Suspect = HealthBox & { key: string; text: string } & (
  | { kind: "looks_like"; suggest_class_id: number; count: number; at_least: boolean; like: HealthBox[]; own: HealthBox | null }
  | { kind: "size"; factor: number; bigger: boolean }
  | { kind: "tiny"; pixels: [number, number] }
  | { kind: "double" | "conflict"; other: HealthBox }
);

export type HealthReport = {
  classes: { id: number; name: string; color: string; boxes: number; images: number }[];
  balance: { most: number; least: number; ratio: number; skewed: boolean; text: string } | null;
  never_taught: string[];
  images: { total: number; finished: number; unfinished: number; unfinished_ids: number[]; to_teach: number; pending: number; errors: number };
  suspects: Suspect[];
  suspect_counts: Partial<Record<Suspect["kind"], number>>;
  suspects_total: number;
  duplicates: (HealthImage & { box_count: number; verified: boolean })[][];
  duplicate_groups: number;
  duplicates_skipped: boolean;
  dismissed: number;
  boxes: number;
  pixel_message: string;
};

// ---------- lesson sessions (BEFORE / AFTER) ----------

export type RecapGuess = Geometry & { class_id: number; region_id: number; level: ConfidenceLevel };

export type Recap = {
  id: number; started_at: string; ended_at: string | null; minutes: number;
  /** judged guesses at the start vs the end ("session"), or before the lesson vs during it ("previous") */
  accuracy: { basis: "session" | "previous"; before: Track; after: Track } | null;
  judged: number; boxes: number; finished: number; corrections: number; confirmed: number; rejected: number;
  gestures: number; propagated: number;
  changed: {
    image_id: number; filename: string; thumb_url: string; kind: "new" | "gone" | "class" | "refined";
    before: RecapGuess[]; after: RecapGuess[];
  }[];
  changed_total: number; taught_from_snapshot: number; snapshot_images: number;
  pixel_message: string;
};

export type RecapSummary = Pick<Recap, "id" | "started_at" | "ended_at" | "minutes" | "accuracy" | "judged" | "boxes" |
  "finished" | "corrections" | "propagated" | "changed_total">;

// ---------- client ----------

/** Sent with every request that changes data: the backend refuses such requests from a browser without it, so other
 * websites cannot forge them (see backend main.py, SECURITY.md). GETs don't need it (no extra CORS preflight). */
const GUARD = { "X-Kweeto": "1" };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const unsafe = (init?.method ?? "GET").toUpperCase() !== "GET";
  const res = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(unsafe ? GUARD : {}),
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  stats: () => req<Stats>("/stats"),

  classes: () => req<LabelClass[]>("/classes"),
  createClass: (name: string) => req<LabelClass>("/classes", { method: "POST", body: json({ name }) }),
  deleteClass: (id: number) => req<{ ok: boolean }>(`/classes/${id}`, { method: "DELETE" }),

  upload: (files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name));
    return req<{ uploaded: number; duplicates: number; rejected: number }>("/images/upload", { method: "POST", body: fd });
  },
  images: (params: { status?: string; offset?: number; limit?: number; q?: string }) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.q) q.set("q", params.q);
    q.set("offset", String(params.offset ?? 0));
    q.set("limit", String(params.limit ?? 60));
    return req<{ total: number; items: ImageSummary[] }>(`/images?${q}`);
  },
  image: (id: number) => req<ImageDetail>(`/images/${id}`),
  similar: (id: number, k = 12) => req<SimilarImage[]>(`/images/${id}/similar?k=${k}`),
  next: (position: number, exclude: number[]) =>
    req<{ image_id: number | null; reason: string }>(`/queue/next?position=${position}&exclude=${exclude.join(",")}`),
  prepareSegment: (id: number) => req<{ ok: boolean }>(`/images/${id}/segment/prepare`, { method: "POST" }),
  segment: (id: number, body: { points?: [number, number][]; box?: [number, number, number, number] | null }) =>
    req<SegmentResult>(`/images/${id}/segment`, { method: "POST", body: json({ points: body.points ?? [], box: body.box ?? null }) }),
  saveAnnotations: (id: number, body: { boxes: BoxInput[]; rejected: RejectedInput[]; done: boolean }) =>
    req<SaveResult>(`/images/${id}/annotations`, { method: "PUT", body: json(body) }),

  batch: () => req<BatchResponse>("/batch"),
  review: (body: { accept: ReviewItem[]; reject: ReviewItem[]; correct: ReviewItem[] }) =>
    req<ReviewResult>("/batch/review", { method: "POST", body: json(body) }),

  questions: () => req<{ questions: Question[] }>("/questions"),
  answer: (id: number, body: { action: string; assignments?: { region_id: number; proposed_class_id: number; class_id: number | null }[] }) =>
    req<AnswerResult>(`/questions/${id}/answer`, { method: "POST", body: json(body) }),
  dismiss: (id: number) => req<{ ok: boolean }>(`/questions/${id}/dismiss`, { method: "POST" }),

  settings: () => req<SettingsResponse>("/settings"),
  updateSettings: (s: Partial<EngineSettings>) => req<SettingsResponse>("/settings", { method: "PUT", body: json(s) }),
  reset: () => req<{ ok: boolean }>("/reset", { method: "POST" }),
  rescan: () => req<{ ok: boolean; images: number }>("/rescan", { method: "POST" }),
  engine: () => req<EngineInfo>("/engine"),

  exports: () => req<ExportInfo>("/exports"),
  createExport: (body: ExportRequest) => req<ExportJob>("/exports", { method: "POST", body: json(body) }),
  exportJob: (id: string) => req<ExportJob>(`/exports/${id}`),
  deleteExport: (id: string) => req<{ deleted: string }>(`/exports/${id}`, { method: "DELETE" }),
  exportDownloadUrl: (id: string) => `${API_URL}/api/exports/${id}/download`,
  training: () => req<TrainingInfo>("/training"),
  startTraining: (body: { model: string; epochs: number; imgsz: number; patience: number; batch: number }) =>
    req<TrainingRun>("/training", { method: "POST", body: json(body) }),
  trainingRun: (id: string) => req<TrainingRun>(`/training/${id}`),
  stopTraining: (id: string) => req<TrainingRun>(`/training/${id}/stop`, { method: "POST" }),
  resumeTraining: (id: string) => req<TrainingRun>(`/training/${id}/resume`, { method: "POST" }),
  deleteTraining: (id: string) => req<{ deleted: string }>(`/training/${id}`, { method: "DELETE" }),
  activateTraining: (id: string) => req<{ active: string | null }>(`/training/${id}/activate`, { method: "POST" }),
  dismissTrainingSuggestion: () => req<{ ok: boolean }>("/training/dismiss-suggestion", { method: "POST" }),
  deactivateTraining: () => req<{ active: string | null }>("/training/deactivate", { method: "POST" }),
  imageDetector: (id: number) => req<DetectorView>(`/images/${id}/detector`),
  trainingDownloadUrl: (id: string, format: "onnx" | "pt") => `${API_URL}/api/training/${id}/download?format=${format}`,

  projects: () => req<ProjectList>("/projects"),
  activeProject: () => req<Project>("/projects/active"),
  createProject: (body: { name: string; pixel?: Partial<PixelTraits>; open?: boolean }) =>
    req<Project>("/projects", { method: "POST", body: json(body) }),
  updateProject: (id: string, body: { name?: string; pixel?: Partial<PixelTraits> }) =>
    req<Project>(`/projects/${id}`, { method: "PATCH", body: json(body) }),
  openProject: (id: string) => req<Project>(`/projects/${id}/open`, { method: "POST" }),
  /** creates and opens the demo project (synthetic images, three classes): see backend demo.py */
  createDemo: () => req<Project>("/projects/demo", { method: "POST" }),
  deleteProject: (id: string) => req<{ deleted: string; active: string }>(`/projects/${id}`, { method: "DELETE" }),
  deleteImage: (id: number) => req<{ deleted: number }>(`/images/${id}`, { method: "DELETE" }),
  deleteImages: (ids: number[]) => req<{ deleted: number }>("/images/delete", { method: "POST", body: json({ ids }) }),
  setEngine: (profile: ProfileName, custom?: CustomEngine) =>
    req<EngineInfo & { rescan: boolean; embeddings_changed: boolean }>("/engine", { method: "PUT", body: json({ profile, custom }) }),

  // import of existing datasets: stage files (the name carries the relative path), preview, commit (background job)
  createImport: () => req<ImportJob>("/imports", { method: "POST" }),
  importFiles: (id: string, files: { file: File; path: string }[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f.file, f.path));
    return req<{ added: number }>(`/imports/${id}/files`, { method: "POST", body: fd });
  },
  importPreview: (id: string, format?: string | null) =>
    req<ImportPreview>(`/imports/${id}/preview${format ? `?format=${format}` : ""}`),
  commitImport: (id: string, body: { format: string | null; complete: boolean; empty_negative: boolean; skip_classes: string[] }) =>
    req<ImportJob>(`/imports/${id}/commit`, { method: "POST", body: json(body) }),
  importJob: (id: string) => req<ImportJob>(`/imports/${id}`),
  discardImport: (id: string) => req<{ ok: boolean }>(`/imports/${id}`, { method: "DELETE" }),

  // dataset health
  health: () => req<HealthReport>("/dataset-health"),
  dismissFinding: (key: string) => req<{ ok: boolean }>("/dataset-health/dismiss", { method: "POST", body: json({ key }) }),
  restoreFindings: () => req<{ restored: number }>("/dataset-health/restore", { method: "POST" }),
  relabelBox: (id: number, class_id: number) =>
    req<{ delta_count: number; message: string }>(`/boxes/${id}`, { method: "PATCH", body: json({ class_id }) }),
  deleteBox: (id: number) => req<{ delta_count: number; message: string }>(`/boxes/${id}`, { method: "DELETE" }),

  // lesson sessions (BEFORE / AFTER recap)
  startSession: (resume?: number | null) =>
    req<{ id: number; started_at: string }>(`/sessions${resume ? `?resume=${resume}` : ""}`, { method: "POST" }),
  endSession: (id: number) => req<Recap>(`/sessions/${id}/end`, { method: "POST" }),
  session: (id: number) => req<Recap>(`/sessions/${id}`),
  sessions: (limit = 5) => req<RecapSummary[]>(`/sessions?limit=${limit}`),
};
