import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const GALLERY = [
  { target: "PCNA", runId: 1385, binderId: 358803, runCode: "P12004-R003", rank: 1 },
  { target: "TAL1", runId: 243, binderId: 28309, runCode: "P17542-R005", rank: 9 },
  { target: "TTR", runId: 1151, binderId: 335403, runCode: "P02766-R002", rank: 1 },
];

const ROTATION_INTERVAL = 9000;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const IMAGE_SIZES = "(max-width: 360px) 90vw, (max-width: 640px) 320px, (max-width: 1100px) 46vw, 520px";

export default function HomeComplexGallery() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(() => !window.matchMedia(REDUCED_MOTION).matches);
  const [isHovered, setIsHovered] = useState(false);
  const [coverLoaded, setCoverLoaded] = useState(false);
  const active = GALLERY[activeIndex];

  useEffect(() => {
    const preference = window.matchMedia(REDUCED_MOTION);
    function handlePreferenceChange(event: MediaQueryListEvent) {
      if (event.matches) setIsPlaying(false);
    }
    preference.addEventListener("change", handlePreferenceChange);
    return () => preference.removeEventListener("change", handlePreferenceChange);
  }, []);

  useEffect(() => {
    if (!coverLoaded || !isPlaying || isHovered) return;

    const timer = window.setInterval(() => {
      if (!document.hidden) setActiveIndex((index) => (index + 1) % GALLERY.length);
    }, ROTATION_INTERVAL);
    return () => window.clearInterval(timer);
  }, [coverLoaded, isPlaying, isHovered]);

  function selectAdjacent(offset: number) {
    setIsPlaying(false);
    setActiveIndex((index) => (index + offset + GALLERY.length) % GALLERY.length);
  }

  function finishLoadingCover() {
    setCoverLoaded(true);
  }

  const rotationLabel = isPlaying ? "Pause slideshow" : "Play slideshow";

  return (
    <figure
      className="home-complex-gallery"
      aria-label="Featured binder complexes"
      onPointerEnter={(event) => setIsHovered(event.pointerType === "mouse")}
      onPointerLeave={() => setIsHovered(false)}
      onFocusCapture={(event) => {
        if (event.target.matches(":focus-visible")) setIsPlaying(false);
      }}
    >
      <div className="home-complex-stage">
        {GALLERY.map(({ target }, index) => {
          const isActive = index === activeIndex;
          if (index !== 0 && !isActive && !coverLoaded) return null;

          const asset = `/hero-complexes/${target.toLowerCase()}`;
          return (
            <img
              key={target}
              className="home-complex-image"
              src={`${asset}-520.webp`}
              srcSet={`${asset}-520.webp 520w, ${asset}-1040.webp 1040w`}
              sizes={IMAGE_SIZES}
              alt={`Predicted ${target}–binder complex. The target is blue and the designed binder is green.`}
              aria-hidden={!isActive}
              width={1040}
              height={640}
              fetchPriority={index === 0 ? "high" : "low"}
              onLoad={index === 0 ? finishLoadingCover : undefined}
              onError={index === 0 ? finishLoadingCover : undefined}
            />
          );
        })}
      </div>
      <figcaption className="home-complex-caption">
        <span aria-live={isPlaying ? "off" : "polite"}>
          <Link
            to={`/runs/${active.runId}?binder=${active.binderId}`}
            title={`${active.runCode}, rank ${active.rank}`}
            aria-label={`View ${active.target} binder, rank ${active.rank} from run ${active.runCode}`}
          >
            <span className="home-complex-target">{active.target}</span>
            {" · "}
            <span className="home-complex-binder">binder</span>
          </Link>
        </span>
        <div className="home-complex-controls" role="group" aria-label="Slideshow controls">
          <button type="button" aria-label={rotationLabel} title={rotationLabel} onClick={() => setIsPlaying((value) => !value)}>
            <span className={isPlaying ? "home-complex-pause-icon" : "home-complex-play-icon"} aria-hidden="true" />
          </button>
          <button type="button" aria-label="Previous complex" title="Previous complex" onClick={() => selectAdjacent(-1)}>
            <span aria-hidden="true">‹</span>
          </button>
          <button type="button" aria-label="Next complex" title="Next complex" onClick={() => selectAdjacent(1)}>
            <span aria-hidden="true">›</span>
          </button>
        </div>
      </figcaption>
    </figure>
  );
}
