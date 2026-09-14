import { formatOffset } from "../format.ts";
import { frameTimeMs, nearestFrame, type TimelineModel } from "../timeline/model.ts";
import { collectorUi } from "../timeline/registry.ts";

interface Props {
  model: TimelineModel;
  cursor: number;
}

/** For every stream, the frame nearest the cursor, rendered by its collector's UI. */
export function DetailsPanel({ model, cursor }: Props) {
  return (
    <section className="details" aria-label="Values at cursor">
      {model.streams.map((series) => {
        const frame = nearestFrame(series.frames, cursor);
        const ui = collectorUi(series.collector);
        return (
          <article className="details-card" key={series.stream}>
            <h2>
              {series.stream}
              {frame && <small>+{formatOffset((frameTimeMs(frame) - model.t0) / 1000)}</small>}
            </h2>
            {frame ? <ui.Details frame={frame} /> : <p className="hint">No frames.</p>}
          </article>
        );
      })}
    </section>
  );
}
