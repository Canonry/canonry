import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { SnapshotReportDto } from '@ainyc/canonry-contracts'
import { formatAuditFactorScore } from './snapshot-format.js'

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const MARGIN = 48
const BRAND = rgb(0.58, 0, 0)
const INK = rgb(0.1, 0.1, 0.1)
const MUTED = rgb(0.38, 0.38, 0.38)
const LINE = rgb(0.82, 0.8, 0.76)
const PASS = rgb(0.18, 0.49, 0.31)
const CAUTION = rgb(0.72, 0.45, 0.2)
const FAIL = rgb(0.7, 0.15, 0.15)

class PdfWriter {
  private readonly usableWidth = PAGE_WIDTH - (MARGIN * 2)
  private page!: PDFPage
  private y = 0

  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.addPage()
  }

  addPage() {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    this.y = PAGE_HEIGHT - MARGIN
  }

  ensureSpace(height: number) {
    if (this.y - height < MARGIN) {
      this.addPage()
    }
  }

  heading(text: string, size = 18) {
    this.ensureSpace(size + 12)
    this.page.drawText(text, {
      x: MARGIN,
      y: this.y,
      size,
      font: this.bold,
      color: BRAND,
    })
    this.y -= size + 8
  }

  subheading(text: string, size = 12) {
    this.ensureSpace(size + 8)
    this.page.drawText(text, {
      x: MARGIN,
      y: this.y,
      size,
      font: this.bold,
      color: INK,
    })
    this.y -= size + 6
  }

  paragraph(text: string, opts?: { size?: number; color?: ReturnType<typeof rgb>; lineHeight?: number }) {
    const size = opts?.size ?? 10
    const color = opts?.color ?? INK
    const lineHeight = opts?.lineHeight ?? size + 4
    const lines = wrapText(this.regular, text, size, this.usableWidth)
    this.ensureSpace((lines.length * lineHeight) + 4)
    for (const line of lines) {
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y,
        size,
        font: this.regular,
        color,
      })
      this.y -= lineHeight
    }
    this.y -= 2
  }

  bullet(text: string) {
    const lines = wrapText(this.regular, text, 10, this.usableWidth - 14)
    this.ensureSpace((lines.length * 14) + 2)
    this.page.drawText('-', {
      x: MARGIN,
      y: this.y,
      size: 10,
      font: this.bold,
      color: BRAND,
    })
    let first = true
    for (const line of lines) {
      this.page.drawText(line, {
        x: MARGIN + 14,
        y: this.y,
        size: 10,
        font: this.regular,
        color: INK,
      })
      this.y -= 14
      if (first) first = false
    }
    this.y -= 2
  }

  rule() {
    this.ensureSpace(8)
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 1,
      color: LINE,
    })
    this.y -= 10
  }

  keyValue(label: string, value: string) {
    const size = 10
    const labelWidth = this.bold.widthOfTextAtSize(`${label}: `, size)
    this.ensureSpace(16)
    this.page.drawText(`${label}:`, {
      x: MARGIN,
      y: this.y,
      size,
      font: this.bold,
      color: INK,
    })
    const lines = wrapText(this.regular, value, size, this.usableWidth - labelWidth - 4)
    let currentY = this.y
    for (const line of lines) {
      this.page.drawText(line, {
        x: MARGIN + labelWidth + 4,
        y: currentY,
        size,
        font: this.regular,
        color: INK,
      })
      currentY -= 14
    }
    this.y = currentY - 2
  }

  table(headers: string[], rows: string[][], widths?: number[]) {
    const columnWidths = widths ?? headers.map(() => this.usableWidth / headers.length)
    const headerHeight = 20
    this.ensureSpace(headerHeight + 10)

    let x = MARGIN
    for (let i = 0; i < headers.length; i++) {
      const width = columnWidths[i]!
      this.page.drawRectangle({
        x,
        y: this.y - headerHeight + 4,
        width,
        height: headerHeight,
        color: BRAND,
      })
      const lines = wrapText(this.bold, headers[i]!, 9, width - 8)
      let lineY = this.y - 10
      for (const line of lines) {
        this.page.drawText(line, {
          x: x + 4,
          y: lineY,
          size: 9,
          font: this.bold,
          color: rgb(1, 0.98, 0.93),
        })
        lineY -= 10
      }
      x += width
    }
    this.y -= headerHeight + 4

    for (const row of rows) {
      const lineCounts = row.map((cell, index) => wrapText(this.regular, cell, 9, columnWidths[index]! - 8).length)
      const rowHeight = Math.max(18, Math.max(...lineCounts) * 11 + 6)
      this.ensureSpace(rowHeight + 4)

      let cellX = MARGIN
      for (let i = 0; i < row.length; i++) {
        const width = columnWidths[i]!
        this.page.drawRectangle({
          x: cellX,
          y: this.y - rowHeight + 4,
          width,
          height: rowHeight,
          borderColor: LINE,
          borderWidth: 0.5,
        })
        const lines = wrapText(this.regular, row[i]!, 9, width - 8)
        let lineY = this.y - 10
        for (const line of lines) {
          this.page.drawText(line, {
            x: cellX + 4,
            y: lineY,
            size: 9,
            font: this.regular,
            color: INK,
          })
          lineY -= 11
        }
        cellX += width
      }
      this.y -= rowHeight + 2
    }

    this.y -= 4
  }
}

export async function writeSnapshotPdf(report: SnapshotReportDto, outputPath: string): Promise<string> {
  const doc = await PDFDocument.create()
  doc.setTitle(`${report.companyName} AI Perception Snapshot`)
  doc.setAuthor('Canonry')
  doc.setSubject('AEO snapshot report')
  doc.setProducer('Canonry')
  doc.setCreator('Canonry')

  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const pdf = new PdfWriter(doc, regular, bold)

  renderCover(pdf, report)
  renderSummary(pdf, report)
  renderAudit(pdf, report)
  renderCompetitors(pdf, report)
  renderQueries(pdf, report)

  const bytes = await doc.save()
  const resolvedPath = path.resolve(outputPath)
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  fs.writeFileSync(resolvedPath, bytes)
  return resolvedPath
}

function renderCover(pdf: PdfWriter, report: SnapshotReportDto) {
  pdf.heading('AI Perception Snapshot', 24)
  pdf.paragraph(report.companyName, { size: 15, color: INK, lineHeight: 18 })
  pdf.paragraph(report.domain, { size: 11, color: MUTED, lineHeight: 14 })
  pdf.rule()
  pdf.keyValue('Generated', new Date(report.generatedAt).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }))
  pdf.keyValue('AEO Audit', `${report.audit.overallScore}/100 (${report.audit.overallGrade})`)
  pdf.keyValue('Visibility Gap', report.summary.visibilityGap)
  pdf.paragraph(report.profile.summary, { size: 11, color: INK, lineHeight: 16 })
  pdf.rule()
}

function renderSummary(pdf: PdfWriter, report: SnapshotReportDto) {
  pdf.heading('What This Means')
  for (const line of report.summary.whatThisMeans) {
    pdf.bullet(line)
  }
  pdf.subheading('Recommended Actions')
  for (const action of report.summary.recommendedActions) {
    pdf.bullet(action)
  }
  pdf.rule()
}

function renderAudit(pdf: PdfWriter, report: SnapshotReportDto) {
  pdf.heading('Audit Snapshot')
  pdf.paragraph(report.audit.summary, { size: 10, color: MUTED, lineHeight: 14 })

  const factorRows = [...report.audit.factors]
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map(factor => [
      factor.name,
      formatAuditFactorScore(factor),
      factor.status,
    ])

  if (factorRows.length > 0) {
    pdf.table(['Weakest factor', 'Score / Weight', 'Status'], factorRows, [270, 120, 126])
  }
  pdf.rule()
}

function renderCompetitors(pdf: PdfWriter, report: SnapshotReportDto) {
  pdf.heading('Recommended Instead')
  if (report.summary.topCompetitors.length === 0) {
    pdf.paragraph('No clear competitor cluster was extracted from the responses.', {
      size: 10,
      color: MUTED,
    })
    pdf.rule()
    return
  }

  pdf.table(
    ['Competitor', 'Mentions'],
    report.summary.topCompetitors.map(entry => [entry.name, String(entry.count)]),
    [420, 96],
  )
  pdf.rule()
}

function renderQueries(pdf: PdfWriter, report: SnapshotReportDto) {
  pdf.heading('Provider Comparison')
  for (const query of report.queryResults) {
    pdf.subheading(query.phrase, 11)
    for (const result of query.providerResults) {
      const status = result.error
        ? 'error'
        : result.mentioned
          ? result.cited ? 'mentioned and cited' : 'mentioned'
          : 'not mentioned'
      const accuracy = result.describedAccurately === 'not-mentioned'
        ? ''
        : `; accuracy: ${result.describedAccurately}`
      const competitors = result.recommendedCompetitors.length > 0
        ? `; recommended instead: ${result.recommendedCompetitors.join(', ')}`
        : ''
      const line = `${result.displayName}: ${status}${accuracy}${competitors}`
      pdf.bullet(line)
      if (result.error) {
        pdf.paragraph(`Error: ${result.error}`, { size: 9, color: FAIL, lineHeight: 12 })
      } else if (result.accuracyNotes) {
        const color = result.describedAccurately === 'yes'
          ? PASS
          : result.describedAccurately === 'no'
            ? FAIL
            : CAUTION
        pdf.paragraph(result.accuracyNotes, { size: 9, color, lineHeight: 12 })
      }
    }
    pdf.rule()
  }
}

function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ['']

  const words = normalized.split(' ')
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next
      continue
    }

    if (current) {
      lines.push(current)
      current = word
      continue
    }

    let chunk = ''
    for (const char of word) {
      const candidate = `${chunk}${char}`
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        chunk = candidate
      } else {
        if (chunk) lines.push(chunk)
        chunk = char
      }
    }
    current = chunk
  }

  if (current) lines.push(current)
  return lines
}
