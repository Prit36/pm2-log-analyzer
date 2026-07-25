import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AggregatedResult,
  ParseOptions,
  WorkerMessage,
  WorkerResponse,
} from '../workers/logParserWorker'
import LogParserWorker from '../workers/logParserWorker.ts?worker&inline'

export type ParseProgress = {
  stage: 'reading' | 'parsing' | 'aggregating' | 'complete'
  processed: number
  total: number
  percent: number
}

export function useLogParserWorker() {
  const workerRef = useRef<Worker | null>(null)
  const [isWorkerReady, setIsWorkerReady] = useState(false)
  const [progress, setProgress] = useState<ParseProgress | null>(null)
  const [result, setResult] = useState<AggregatedResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isParsing, setIsParsing] = useState(false)

  const resolveRef = useRef<((value: AggregatedResult) => void) | null>(null)
  const rejectRef = useRef<((reason: Error) => void) | null>(null)

  useEffect(() => {
    const worker = new LogParserWorker()
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      switch (msg.type) {
        case 'PROGRESS':
          setProgress(msg.payload)
          break
        case 'RESULT':
          setResult(msg.payload)
          setProgress({ stage: 'complete', processed: 100, total: 100, percent: 100 })
          setIsParsing(false)
          resolveRef.current?.(msg.payload)
          resolveRef.current = null
          rejectRef.current = null
          break
        case 'ERROR':
          setError(msg.payload.message)
          setIsParsing(false)
          rejectRef.current?.(new Error(msg.payload.message))
          resolveRef.current = null
          rejectRef.current = null
          break
        case 'DONE':
          break
      }
    }

    worker.onerror = (err) => {
      const message = err.message || 'Worker error'
      setError(message)
      setIsParsing(false)
      rejectRef.current?.(new Error(message))
      resolveRef.current = null
      rejectRef.current = null
    }

    setIsWorkerReady(true)
    return () => {
      worker.terminate()
      workerRef.current = null
      setIsWorkerReady(false)
    }
  }, [])

  const run = useCallback((message: WorkerMessage): Promise<AggregatedResult> => {
    return new Promise((resolve, reject) => {
      if (!workerRef.current) {
        reject(new Error('Worker not ready'))
        return
      }
      setIsParsing(true)
      setError(null)
      setProgress({ stage: 'parsing', processed: 0, total: 100, percent: 0 })
      resolveRef.current = resolve
      rejectRef.current = reject
      workerRef.current.postMessage(message)
    })
  }, [])

  const parseFile = useCallback(
    (file: File, options: ParseOptions) => run({ type: 'PARSE_FILE', payload: { file, options } }),
    [run],
  )

  const parseText = useCallback(
    (text: string, options: ParseOptions) => run({ type: 'PARSE_TEXT', payload: { text, options } }),
    [run],
  )

  const reaggregate = useCallback(
    (options: ParseOptions) => run({ type: 'REAGGREGATE', payload: { options } }),
    [run],
  )

  const cancel = useCallback(() => {
    workerRef.current?.postMessage({ type: 'CANCEL' } satisfies WorkerMessage)
    setIsParsing(false)
  }, [])

  const clear = useCallback(() => {
    workerRef.current?.postMessage({ type: 'CLEAR' } satisfies WorkerMessage)
    setResult(null)
    setProgress(null)
    setError(null)
  }, [])

  return {
    parseFile,
    parseText,
    reaggregate,
    cancel,
    clear,
    isWorkerReady,
    isParsing,
    progress,
    result,
    error,
    setResult,
  }
}

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}
