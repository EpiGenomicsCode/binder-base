export default function About() {
  return (
    <div className="hero hero-page">
      <h1 className="hero-title">About</h1>
      <div className="about-body">
        <p className="about-section-body">
          Binder Base is a community resource for researchers to submit and explore
          protein binder design experiments. Each protein is identified by its UniProt
          ID and can be associated with one or more design runs.
        </p>
        <p className="about-section-body">
          Binder Base tracks the algorithm, parameters, and date of each experiment.
          The resulting binder sequences are stored alongside success or failure
          annotations based on each algorithm's QC metrics, making it easy to track
          what has been tried and what has worked.
        </p>
      </div>
    </div>
  );
}
