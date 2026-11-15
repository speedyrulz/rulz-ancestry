import { useEffect, useRef, useState } from 'react';
import type {
  CensusCountyInfo,
  CensusDistrictInfo,
  CensusDistrictSummary,
  PackInfo,
  TreeState,
} from '../../../shared/ipc';
import { api, errorMessage } from '../api';

interface CensusPanelProps {
  packs: PackInfo[];
  personId: string;
  name: string;
  onTree: (tree: TreeState) => void;
  onNotice: () => void;
}

export function CensusPanel({ packs, personId, name, onTree, onNotice }: CensusPanelProps) {
  const [packId, setPackId] = useState(packs[0]?.id ?? '');
  const [counties, setCounties] = useState<CensusCountyInfo[]>([]);
  const [county, setCounty] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [offsets, setOffsets] = useState([0]);
  const offset = offsets[offsets.length - 1] ?? 0;
  const [districts, setDistricts] = useState<CensusDistrictSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [district, setDistrict] = useState<CensusDistrictInfo | null>(null);
  const [page, setPage] = useState(1);
  const [requestedPage, setRequestedPage] = useState(1);
  const [shown, setShown] = useState<{ url: string; page: number } | null>(null);
  const [zoom, setZoom] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cited, setCited] = useState<string | null>(null);
  const [citing, setCiting] = useState(false);
  const imageRequest = useRef(0);
  const imageUrl = useRef<string | null>(null);
  const districtRequest = useRef(0);
  const citeRequest = useRef(0);

  const clearImage = () => {
    imageRequest.current += 1;
    citeRequest.current += 1;
    if (imageUrl.current !== null) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = null;
    setShown(null);
    setBusy(false);
    setCited(null);
    setCiting(false);
  };
  useEffect(
    () => () => {
      imageRequest.current += 1;
      districtRequest.current += 1;
      citeRequest.current += 1;
      if (imageUrl.current !== null) URL.revokeObjectURL(imageUrl.current);
    },
    [],
  );

  useEffect(() => {
    let current = true;
    void api.censusCounties(packId).then(
      (result) => {
        if (!current) return;
        if (result.ok) setCounties(result.counties);
        else setError(result.message);
      },
      (failure: unknown) => {
        if (current) setError(errorMessage(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [packId]);

  useEffect(() => {
    let current = true;
    if (county !== null) {
      void api.censusDistricts({ packId, county, filter, offset }).then(
        (result) => {
          if (!current) return;
          if (result.ok) {
            setDistricts(result.districts);
            setTotal(result.total);
          } else setError(result.message);
        },
        (failure: unknown) => {
          if (current) setError(errorMessage(failure));
        },
      );
    }
    return () => {
      current = false;
    };
  }, [packId, county, filter, offset]);

  const selectDistrict = (id: number, generation: number) => {
    const request = ++districtRequest.current;
    clearImage();
    setDistrict(null);
    setError(null);
    setPage(1);
    setRequestedPage(1);
    void api.censusDistrict({ packId, id, generation }).then(
      (result) => {
        if (request !== districtRequest.current) return;
        if (result.ok) setDistrict(result.district);
        else setError(result.message);
      },
      (failure: unknown) => {
        if (request === districtRequest.current) setError(errorMessage(failure));
      },
    );
  };
  const resetDistrict = () => {
    districtRequest.current += 1;
    setDistrict(null);
    clearImage();
  };
  const view = (number: number) => {
    if (district === null || !Number.isInteger(number) || number < 1 || number > district.pages)
      return;
    clearImage();
    const request = ++imageRequest.current;
    setPage(number);
    setRequestedPage(number);
    setBusy(true);
    setError(null);
    void api
      .censusPageImage({
        packId,
        id: district.id,
        generation: district.generation,
        page: number,
      })
      .then(
        (result) => {
          if (request !== imageRequest.current) return;
          if (!result.ok) {
            if (result.problem.kind === 'notice') onNotice();
            else setError(result.problem.message);
            return;
          }
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(result.bytes)], { type: 'image/jpeg' }),
          );
          imageUrl.current = url;
          setShown({ url, page: result.page });
          setPage(result.page);
        },
        (failure: unknown) => {
          if (request === imageRequest.current) setError(errorMessage(failure));
        },
      )
      .finally(() => {
        if (request === imageRequest.current) setBusy(false);
      });
  };

  return (
    <section className="record-source census-panel" data-testid="census-panel">
      <h3>1950 US census</h3>
      <p className="hint">
        The 1950 census has no index of names here. Look through a district pages, or search names
        at NARA.
      </p>
      <label>
        State{' '}
        <select
          value={packId}
          onChange={(event) => {
            resetDistrict();
            setCounties([]);
            setCounty(null);
            setFilter('');
            setDistricts([]);
            setTotal(0);
            setError(null);
            setPackId(event.target.value);
            setOffsets([0]);
          }}
        >
          {packs.map((pack) => (
            <option key={pack.id} value={pack.id}>
              {pack.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        County{' '}
        <select
          data-testid="census-county"
          value={
            county === null ? '' : String(counties.findIndex((item) => item.name === county) + 1)
          }
          onChange={(event) => {
            resetDistrict();
            setError(null);
            setDistricts([]);
            setTotal(0);
            setOffsets([0]);
            setCounty(counties[Number(event.target.value) - 1]?.name ?? null);
          }}
        >
          <option value="">Choose a county</option>
          {counties.map((item, index) => (
            <option key={item.name} value={index + 1}>
              {item.name || 'All districts'} ({item.districts})
            </option>
          ))}
        </select>
      </label>
      {county !== null && (
        <>
          <label>
            Filter descriptions{' '}
            <input
              value={filter}
              onChange={(event) => {
                resetDistrict();
                setError(null);
                setDistricts([]);
                setTotal(0);
                setOffsets([0]);
                setFilter(event.target.value);
              }}
            />
          </label>
          <ul className="census-districts">
            {districts.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid={`census-district-${item.id}`}
                  onClick={() => selectDistrict(item.id, item.generation)}
                >
                  ED {item.ed || '—'}: {item.descriptionStart} ({item.pages} pages)
                </button>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button
              type="button"
              disabled={offsets.length <= 1}
              onClick={() => {
                setError(null);
                setDistricts([]);
                setOffsets((old) => old.slice(0, -1));
              }}
            >
              Previous districts
            </button>
            <span>{total} districts</span>
            <button
              type="button"
              disabled={districts.length === 0 || offset + districts.length >= total}
              onClick={() => {
                setError(null);
                setOffsets((old) => [...old, offset + districts.length]);
                setDistricts([]);
              }}
            >
              Next districts
            </button>
          </div>
        </>
      )}
      {district !== null && (
        <div className="census-detail">
          <h4>ED {district.ed || '—'}</h4>
          <p>{district.description}</p>
          <p>
            Roll: {district.roll || 'Unknown'} · {district.pages} pages
          </p>
          <div className="actions">
            <label>
              Page{' '}
              <input
                type="number"
                min={1}
                max={district.pages}
                value={page}
                onChange={(event) => setPage(Number(event.target.value))}
              />
            </label>
            <button
              type="button"
              data-testid="census-view"
              disabled={page < 1 || page > district.pages || !Number.isInteger(page)}
              onClick={() => view(page)}
            >
              View page
            </button>
            <button
              type="button"
              disabled={(shown?.page ?? requestedPage) <= 1}
              onClick={() => view((shown?.page ?? requestedPage) - 1)}
            >
              Previous page
            </button>
            <button
              type="button"
              disabled={(shown?.page ?? requestedPage) >= district.pages}
              onClick={() => view((shown?.page ?? requestedPage) + 1)}
            >
              Next page
            </button>
            <button
              type="button"
              data-testid="census-nara"
              onClick={() => {
                void api
                  .openCensusDistrict({
                    packId,
                    id: district.id,
                    generation: district.generation,
                  })
                  .then(
                    (result) => {
                      if (!result.ok) setError(result.message);
                    },
                    (failure: unknown) => setError(errorMessage(failure)),
                  );
              }}
            >
              Open at NARA
            </button>
          </div>
          {busy && <p className="muted">Loading page…</p>}
          {shown !== null && (
            <>
              <label>
                Zoom{' '}
                <input
                  type="range"
                  min="50"
                  max="300"
                  step="25"
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                />{' '}
                {zoom}%
              </label>
              <div className="census-image-frame">
                <img
                  data-testid="census-image"
                  src={shown.url}
                  alt={`Census page ${shown.page}`}
                  style={{ width: `${zoom}%` }}
                />
              </div>
            </>
          )}
          <button
            type="button"
            data-testid="census-cite"
            disabled={shown === null || busy || citing}
            onClick={() => {
              if (shown === null) return;
              const request = ++citeRequest.current;
              setCiting(true);
              setCited(null);
              setError(null);
              void api
                .citeCensusPage({
                  packId,
                  id: district.id,
                  generation: district.generation,
                  page: shown.page,
                  personId,
                })
                .then(
                  (result) => {
                    // The citation is in the tree whatever has happened in the window since.
                    if (result.ok) onTree(result.tree);
                    if (request !== citeRequest.current) return;
                    if (!result.ok) setError(result.problem.message);
                    else setCited(result.added ? 'Citation added.' : 'Already cited.');
                  },
                  (failure: unknown) => {
                    if (request === citeRequest.current) setError(errorMessage(failure));
                  },
                )
                .finally(() => {
                  if (request === citeRequest.current) setCiting(false);
                });
            }}
          >
            Cite this page for {name}
          </button>
          {cited !== null && (
            <p className="notice" role="status">
              {cited}
            </p>
          )}
        </div>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
