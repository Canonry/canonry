import type CDP from 'chrome-remote-interface'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Capture a cropped screenshot of a specific DOM element.
 * Falls back to full viewport if the element can't be found.
 */
export async function captureElementScreenshot(
  client: CDP.Client,
  selector: string,
  outputPath: string,
): Promise<string> {
  // Ensure output directory exists
  const dir = path.dirname(outputPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined

  try {
    // Find the element and get its bounding box
    const { result } = await client.Runtime.evaluate({
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      })()`,
      returnByValue: true,
    })

    if (result.value && typeof result.value === 'object') {
      const rect = result.value as { x: number; y: number; width: number; height: number }
      if (rect.width > 0 && rect.height > 0) {
        clip = { ...rect, scale: 1 }
      }
    }
  } catch {
    // Element not found — fall back to full viewport
  }

  const screenshotParams: { format: 'png'; clip?: typeof clip } = {
    format: 'png' as const,
  }
  if (clip) {
    screenshotParams.clip = clip
  }

  const { data } = await client.Page.captureScreenshot(screenshotParams)
  const buffer = Buffer.from(data, 'base64')
  fs.writeFileSync(outputPath, buffer)

  return outputPath
}
