import { useCallback, useRef, useState } from 'react'
import { formatBytes } from '../utils/format'

interface FileDropProps {
  onFile: (file: File) => void
  disabled?: boolean
  progress?: { percent: number; label?: string } | null
}

export function FileDrop({ onFile, disabled, progress }: FileDropProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const busy = Boolean(progress) || disabled

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file || busy) return
      onFile(file)
    },
    [busy, onFile],
  )

  return (
    <div
      className={
        'rounded-xl border border-dashed p-4 transition ' +
        (dragOver ? 'border-indigo-400 bg-indigo-50' : 'border-slate-300 bg-white') +
        (busy ? ' opacity-80' : '')
      }
      onDragEnter={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        handleFile(e.dataTransfer.files?.[0])
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Upload PM2 log file</div>
          <div className="text-xs text-slate-600">
            Drag & drop a .log/.txt file — large files (50MB+) parse in a background worker so the UI stays responsive.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            Browse
          </button>
          <input
            ref={inputRef}
            className="hidden"
            type="file"
            accept=".log,.txt,text/plain"
            disabled={busy}
            onChange={(e) => {
              handleFile(e.target.files?.[0])
              e.currentTarget.value = ''
            }}
          />
        </div>
      </div>

      {progress && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
            <span>{progress.label ?? 'Processing…'}</span>
            <span>{progress.percent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-indigo-600 transition-all duration-200" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}
    </div>
  )
}

export { formatBytes }
