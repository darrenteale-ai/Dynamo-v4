import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import ShiftModal from '../components/ShiftModal.jsx';

const TYPES = ['All', 'CORE', 'RRV', 'RELIEF', 'TRAINING', 'STANDBY'];

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'long', year: 'numeric',
  });
}
function fmtTime(d) {
  return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function startOfWeek(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = (day === 0 ? -6 : 1) - day; // Monday start
  dt.setDate(dt.getDate() + diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

export default function Shifts() {
  const [weekStart, setWeekStart] = useState(startOfWeek(new Date()));
  const [vehicle, setVehicle] = useState('');
  const [area, setArea] = useState('');
  const [type, setType] = useState('All');
  const [q, setQ] = useState('');
  const [shifts, setShifts] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // shift object or 'new' or null
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const weekEnd = useMemo(() => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + 6);
    d.setHours(23, 59, 59, 999);
    return d;
  }, [weekStart]);

  async function load() {
    setLoading(true);
    try {
      const data = await api.listShifts({
        startFrom: weekStart.toISOString(),
        startTo: weekEnd.toISOString(),
        vehicle,
        area,
        type,
        q,
      });
      setShifts(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api.listStaff().then(setStaff);
  }, []);

  useEffect(() => {
    load();
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  function shiftWeek(delta) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + delta * 7);
    setWeekStart(d);
  }

  const paged = shifts.slice((page - 1) * pageSize, page * pageSize);
  const totalPages = Math.max(1, Math.ceil(shifts.length / pageSize));

  return (
    <div>
      <div className="page-header">
        <h1>Shifts</h1>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Create shift</button>
      </div>

      <div className="filters card">
        <div className="filters-row">
          <div className="form-field">
            <label>Week</label>
            <div className="week-nav">
              <button type="button" className="btn btn-ghost" onClick={() => shiftWeek(-1)}>‹</button>
              <div className="week-label">
                {weekStart.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – {weekEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
              </div>
              <button type="button" className="btn btn-ghost" onClick={() => shiftWeek(1)}>›</button>
            </div>
          </div>
          <div className="form-field">
            <label>Vehicle</label>
            <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="All vehicles" />
          </div>
          <div className="form-field">
            <label>Area</label>
            <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="All areas" />
          </div>
          <div className="form-field">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label>Search ref</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. BKE062" />
          </div>
          <div className="form-field form-field-btn">
            <button className="btn btn-primary" onClick={() => { load(); setPage(1); }}>Search</button>
          </div>
        </div>
      </div>

      <div className="card table-card">
        {loading ? (
          <div className="empty">Loading…</div>
        ) : shifts.length === 0 ? (
          <div className="empty">No shifts found for this week.</div>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Date</th>
                  <th>Period</th>
                  <th>Type</th>
                  <th>Crew</th>
                  <th>Vehicle</th>
                  <th>Area</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {paged.map((s) => (
                  <tr key={s.id} className="row-clickable" onClick={() => setEditing(s)}>
                    <td><span className="ref-link">{s.ref}</span></td>
                    <td>{fmtDate(s.date)}</td>
                    <td>{fmtTime(s.startTime)} - {fmtTime(s.endTime)}</td>
                    <td><span className="badge badge-blue">{s.type}</span></td>
                    <td>
                      {s.crew.map((c, i) => (
                        <div key={i} className="crew-cell">
                          <span className="crew-num">{c.position}</span>
                          {c.name ? `${c.name} ${c.roleLabel ? `(${c.roleLabel})` : ''}` : <span className="muted">Unassigned</span>}
                        </div>
                      ))}
                    </td>
                    <td>{s.vehicle || '—'}</td>
                    <td>{s.area || '—'}</td>
                    <td className="actions-cell">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={(e) => { e.stopPropagation(); setEditing(s); }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pagination">
              <div>Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, shifts.length)} of {shifts.length} shifts</div>
              <div className="pagination-controls">
                <button className="btn btn-ghost btn-sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>‹</button>
                <span>{page} / {totalPages}</span>
                <button className="btn btn-ghost btn-sm" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>›</button>
              </div>
            </div>
          </>
        )}
      </div>

      {editing && (
        <ShiftModal
          shift={editing === 'new' ? null : editing}
          staff={staff}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
          onDeleted={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
