import React from 'react'

export function FileDrop({
  onText,
}: {
  onText: (text: string, meta?: { name?: string }) => void
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [dragOver, setDragOver] = React.useState(false)

  async function readFile(file: File) {
    const text = await file.text()
    onText(text, { name: file.name })
  }

  return (
    <div
      className={
        'rounded-xl border border-dashed p-4 transition ' +
        (dragOver ? 'border-indigo-400 bg-indigo-50' : 'border-slate-300 bg-white')
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
      onDrop={async (e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        const file = e.dataTransfer.files?.[0]
        if (file) await readFile(file)
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Upload PM2 log file</div>
          <div className="text-xs text-slate-600">Drag & drop a .log/.txt file here, or browse.</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            onClick={() => inputRef.current?.click()}
          >
            Browse
          </button>
          <input
            ref={inputRef}
            className="hidden"
            type="file"
            accept=".log,.txt,text/plain"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (file) await readFile(file)
              e.currentTarget.value = ''
            }}
          />
        </div>
      </div>
    </div>
  )
}
