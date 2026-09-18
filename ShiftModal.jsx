import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

const TYPES = ['CORE', 'RRV', 'RELIEF', 'TRAINING', 'STANDBY'];
const STATUSES = ['DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];
const QUALIFICATIONS = ['PARA', 'ECA', 'TECH', 'NQP1'];

function toDateInput(d) {
  const dt = new Date(d);
  return dt.toISOString().slice(0, 10);
}
function toTimeInput(d) {
  const dt = new Date(d);
  return dt.toISOString().slice(11, 16);
}
function combine(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00`).toISOString();
}

export default function ShiftModal({ shift, staff, onClose, onSaved, onDeleted }) {
  const isEdit = !!shift;
  const [date, setDate] = useState(shift ? toDateInput(shift.date) : new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState(shift ? toTimeInput(shift.startTime) : '10:00');
  const [endTime, setEndTime] = useState(shift ? toTimeInput(shift.endTime) : '22:00');
  const [type, setType] = useState(shift?.type || 'CORE');
  const [status, setStatus] = useState(shift?.status || 'CONFIRMED');
  const [vehicle, setVehicle] = useState(shift?.vehicle || '');
  const [area, setArea] = useState(shift?.area || '');
  const [notes, setNotes] = useState(shift?.notes || '');
  const [crew, setCrew] = useState(
    shift?.crew?.map((c) => ({ userId: c.userId || '', roleLabel: c.roleLabel || '' })) || [
      { userId: '', roleLabel: '' },
      { userId: '', roleLabel: '' },
    ]
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function updateCrew(i, field, value) {
    setCrew((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value };
      if (field === 'userId') {
        const u = staff.find((s) => s.id === value);
        if (u) next[i].roleLabel = u.qualification || next[i].roleLabel;
      }
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const startISO = combine(date, startTime);
      let endISO = combine(date, endTime);
      // overnight shift: end time earlier than start time means next day
      if (new Date(endISO) <= new Date(startISO)) {
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);
        endISO = combine(nextDay.toISOString().slice(0, 10), endTime);
      }
      const payload = {
        date: new Date(date).toISOString(),
        startTime: startISO,
        endTime: endISO,
        type,
        status,
        vehicle,
        area,
        notes,
        crew: crew.map((c) => ({ userId: c.userId || null, roleLabel: c.roleLabel || null })),
      };
      if (isEdit) {
        await api.updateShift(shift.id, payload);
      } else {
        await api.createShift(payload);
      }
      onSaved();
    } catch (err) {
      setError(err.message || 'Failed to save shift');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this shift? This cannot be undone.')) return;
    setBusy(true);
    try {
      await api.deleteShift(shift.id);
      onDeleted();
    } catch (err) {
      setError(err.message || 'Failed to delete shift');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="modal-header">
          <h2>{isEdit ? `Edit shift ${shift.ref}` : 'Create shift'}</h2>
          <button type="button" className="modal-close" onClick={onClose}>✕</button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="form-grid">
          <div className="form-field">
            <label>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div className="form-field">
            <label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className="form-field">
            <label>Start time</label>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
          </div>
          <div className="form-field">
            <label>End time</label>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
          </div>

          <div className="form-field">
            <label>Vehicle</label>
            <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="e.g. DSA 3" />
          </div>
          <div className="form-field">
            <label>Area</label>
            <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Luton" />
          </div>

          <div className="form-field">
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="form-field" />

          <div className="form-field form-field-wide">
            <label>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>

        <div className="crew-section">
          <div className="crew-title">Crew</div>
          {crew.map((c, i) => (
            <div className="crew-row" key={i}>
              <div className="crew-position">{i + 1}</div>
              <select
                value={c.userId}
                onChange={(e) => updateCrew(i, 'userId', e.target.value)}
              >
                <option value="">— Unassigned —</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <select
                value={c.roleLabel}
                onChange={(e) => updateCrew(i, 'roleLabel', e.target.value)}
              >
                <option value="">Role</option>
                {QUALIFICATIONS.map((q) => <option key={q} value={q}>{q}</option>)}
              </select>
            </div>
          ))}
        </div>

        <div className="modal-footer">
          {isEdit && (
            <button type="button" className="btn btn-danger" onClick={handleDelete} disabled={busy}>
              Delete
            </button>
          )}
          <div className="modal-footer-right">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create shift'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
