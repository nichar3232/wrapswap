import { devLanes, suiFile, unichainFile, type FlowNode } from "./flowData";

function Node({ n }: { n: FlowNode }) {
  const body = (
    <>
      <span className="dn-does">{n.does}</span>
      <span className="dn-contract">{n.contract}</span>
      {n.sub && <span className="dn-sub">{n.sub}</span>}
    </>
  );
  return n.href ? (
    <a className={`dn dn-link${n.accent ? " dn-accent" : ""}`} href={n.href} target="_blank" rel="noreferrer" data-node={n.id} aria-label={`${n.does}: ${n.contract} on the block explorer`}>
      {body}
    </a>
  ) : (
    <div className={`dn${n.accent ? " dn-accent" : ""}`} data-node={n.id}>
      {body}
    </div>
  );
}

/** Developers: v4 call order with the Dark Cross and Sui lanes; HTML lanes, so nothing clips. */
export function DevDiagram() {
  const lanes = devLanes(unichainFile, suiFile);
  return (
    <figure className="dev-diagram" aria-label="Contract call order">
      {lanes.map((lane) => (
        <div key={lane.id} className={`lane lane-${lane.id}${lane.secondary ? " secondary" : ""}`}>
          <span className="lane-label">{lane.label}</span>
          <ol className="lane-nodes">
            {lane.nodes.map((n, i) => (
              <li key={n.id}>
                {i > 0 && (
                  <span className="dn-arrow" aria-hidden="true">
                    →
                  </span>
                )}
                <Node n={n} />
              </li>
            ))}
          </ol>
        </div>
      ))}
    </figure>
  );
}
