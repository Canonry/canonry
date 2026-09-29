import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { ANSWER_MARKDOWN_COPY, AnswerMarkdown } from '../src/components/shared/AnswerMarkdown.js'

const headingFixture = [
  '## Local recommendations',
  '',
  '**North Office** has *flexible hours*.',
  '',
  '### Getting there',
  '',
  '1. Take the train.',
  '2. Walk north.',
  '',
  '###### Access details',
  '',
  'Use the east entrance.',
].join('\n')

function setClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
  onTestFinished(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
}

afterEach(cleanup)

describe('AnswerMarkdown', () => {
  test('highlights prose across headings, emphasis and lists while excluding links, URLs and code', () => {
    const markdown = [
      '# Northwind guide', '', '**Northwind** has *Northwind options*.', '',
      '- Northwind widgets', '', '[Northwind](https://northwind.example)', '',
      'https://northwind.example', '', '`Northwind`', '', '```text', 'Northwind', '```',
    ].join('\n')
    const { container } = render(<AnswerMarkdown highlightGroups={[{ terms: ['Northwind'], className: 'answer-highlight-brand' }]}>{markdown}</AnswerMarkdown>)
    expect(container.querySelectorAll('mark')).toHaveLength(4)
    expect(container.querySelector('h4 mark')?.textContent).toBe('Northwind')
    expect(container.querySelector('strong mark')?.textContent).toBe('Northwind')
    expect(container.querySelector('em mark')?.textContent).toBe('Northwind')
    expect(container.querySelector('li mark')?.textContent).toBe('Northwind')
    expect(container.querySelector('a mark, code mark')).toBeNull()
    expect(screen.getByText('https://northwind.example').querySelector('mark')).toBeNull()
  })

  test('truncates a parsed link label without exposing Markdown syntax or changing its destination', () => {
    const { container } = render(<AnswerMarkdown previewLength={8}>{'[Northwind reference](https://northwind.example/a-long-saved-destination) and more.'}</AnswerMarkdown>)
    const link = screen.getByRole('link', { name: 'Northwin…' })
    expect(link.getAttribute('href')).toBe('https://northwind.example/a-long-saved-destination')
    expect(container.textContent).toBe('Northwin…')
  })

  test('truncates formatted list text while keeping emphasis and removing later items', () => {
    const { container } = render(<AnswerMarkdown previewLength={12}>{'- **Northwind** widgets\n- Other choices'}</AnswerMarkdown>)
    expect(container.querySelector('strong')?.textContent).toBe('Northwind…')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('listitem').textContent).toBe('Northwind…')
    expect(container.textContent).not.toContain('Other choices')
  })

  test('keeps nearby whole words at the parsed preview cutoff', () => {
    const { container } = render(<AnswerMarkdown previewLength={16}>{'Northwind offers useful widgets.'}</AnswerMarkdown>)
    expect(container.textContent).toBe('Northwind offers…')
  })

  test('preserves a reference link destination when its definition is after the preview cutoff', () => {
    render(<AnswerMarkdown previewLength={5}>{'[Northwind][saved]\n\nMore text\n\n[saved]: https://northwind.example/reference'}</AnswerMarkdown>)
    expect(screen.getByRole('link', { name: 'North…' }).getAttribute('href')).toBe('https://northwind.example/reference')
  })

  test.each([
    { length: 9, expected: 'Northwind' },
    { length: 8, expected: 'Northwin…' },
    { length: 0, expected: '…' },
  ])('adds an ellipsis only when the parsed answer exceeds $length characters', ({ length, expected }) => {
    const { container } = render(<AnswerMarkdown previewLength={length}>{'**Northwind**'}</AnswerMarkdown>)
    expect(container.textContent).toBe(expected)
  })

  test('preview truncation retains safe-link and remote-image protections', () => {
    const { container } = render(<AnswerMarkdown previewLength={20}>{'[Unsafe](javascript:alert%281%29) ![Remote map](https://example.com/map.png) more text'}</AnswerMarkdown>)
    expect(screen.queryByRole('link')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('Unsafe Remote map…')
  })

  test('rebases the shallowest source heading to h4 and preserves nesting up to h6', () => {
    const { container } = render(<AnswerMarkdown>{headingFixture}</AnswerMarkdown>)
    expect(screen.getByRole('heading', { name: 'Local recommendations', level: 4 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Getting there', level: 5 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Access details', level: 6 })).toBeTruthy()
    expect(container.querySelector('h1, h2, h3')).toBeNull()
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
    expect(container.querySelector('strong')?.textContent).toBe('North Office')
    expect(container.querySelector('em')?.textContent).toBe('flexible hours')
    expect(screen.queryByRole('button')).toBeNull()
  })

  test.each([
    { answer: '3. Third option\n4. Fourth option', starts: [3] },
    { answer: '1. First option\n2. Second option\n\nOther options:\n\n3. Third option\n4. Fourth option', starts: [1, 3] },
  ])('preserves the starting and resumed numbers in $starts', ({ answer, starts }) => {
    render(<AnswerMarkdown>{answer}</AnswerMarkdown>)
    expect(screen.getAllByRole('list').map(list => (list as HTMLOListElement).start)).toEqual(starts)
  })

  test('uses parsed headings, including setext headings, without treating fenced code as structure', () => {
    const markdown = [
      '```md', '# Not a heading', '```', '',
      'Overview', '--------', '', '### More detail', '', '#### Exact location',
    ].join('\n')
    const { rerender } = render(<AnswerMarkdown headingLevel={3}>{markdown}</AnswerMarkdown>)
    expect(screen.getByRole('heading', { name: 'Overview', level: 3 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'More detail', level: 4 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Exact location', level: 5 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Not a heading' })).toBeNull()
    expect(screen.getByText('# Not a heading').tagName).toBe('CODE')
    rerender(<AnswerMarkdown headingLevel={6}>{markdown}</AnswerMarkdown>)
    expect(screen.getAllByRole('heading', { level: 6 })).toHaveLength(3)
  })

  test('keeps raw HTML inert, renders safe links, and never loads remote images', () => {
    const markdown = [
      '# Provider answer', '',
      '[Details](https://example.com/details) and [Unsafe](javascript:alert%281%29).', '',
      '![Location map](https://example.com/map.png)', '',
      '<img src="https://example.com/tracker.png" onerror="alert(1)">', '',
      '<script>alert(1)</script>',
    ].join('\n')
    const { container } = render(<AnswerMarkdown>{markdown}</AnswerMarkdown>)
    const link = screen.getByRole('link', { name: 'Details' })
    expect(link.getAttribute('href')).toBe('https://example.com/details')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getByText('Unsafe').tagName).toBe('SPAN')
    expect(screen.getByText('Location map').tagName).toBe('SPAN')
    expect(container.querySelector('script, img, h1')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  test('copies every character of a long saved answer and reports pending and success inline', async () => {
    let completeCopy!: () => void
    const writeText = vi.fn(() => new Promise<void>(resolve => { completeCopy = resolve }))
    setClipboard({ writeText })
    const answer = `  ## Complete saved answer\n\n${'A recorded paragraph. '.repeat(600)}\n\n[Details](https://example.com/details)\n\n**Final recorded sentence.**  \n`
    render(<AnswerMarkdown copyable>{answer}</AnswerMarkdown>)
    expect(screen.getByText('Final recorded sentence.')).toBeTruthy()
    const button = screen.getByRole('button', { name: ANSWER_MARKDOWN_COPY.copy })
    expect(button.getAttribute('type')).toBe('button')
    fireEvent.click(button)
    expect(writeText).toHaveBeenCalledExactlyOnceWith(answer)
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { completeCopy() })
    expect(screen.getByRole('status').textContent).toBe(ANSWER_MARKDOWN_COPY.copied)
    expect(screen.getByRole('button', { name: ANSWER_MARKDOWN_COPY.copy })).toHaveProperty('disabled', false)
  })

  test.each(['copied', 'failed'] as const)('preserves focus, blocks duplicate copies, and allows retry after %s', async outcome => {
    let finishCopy!: () => void
    const writeText = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finishCopy = () => { if (outcome === 'copied') resolve(); else reject(new Error('denied')) }
    })).mockResolvedValue(undefined)
    setClipboard({ writeText })
    render(<AnswerMarkdown copyable>{headingFixture}</AnswerMarkdown>)
    const button = screen.getByRole('button', { name: ANSWER_MARKDOWN_COPY.copy })
    button.focus()
    act(() => { button.click(); button.click() })
    expect(writeText).toHaveBeenCalledExactlyOnceWith(headingFixture)
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(button)
    await act(async () => { finishCopy() })
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute('aria-disabled')).toBe('false')
    expect(screen.getByRole('status').textContent).toBe(ANSWER_MARKDOWN_COPY[outcome])
    await act(async () => { button.click() })
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).toBe(ANSWER_MARKDOWN_COPY.copied)
  })

  test('does not move focus back when the user leaves a pending copy', async () => {
    let finishCopy!: () => void
    setClipboard({ writeText: () => new Promise<void>(resolve => { finishCopy = resolve }) })
    render(<><AnswerMarkdown copyable>{headingFixture}</AnswerMarkdown><a href="#details">Details</a></>)
    const button = screen.getByRole('button', { name: ANSWER_MARKDOWN_COPY.copy })
    button.focus()
    fireEvent.click(button)
    const nextControl = screen.getByRole('link')
    nextControl.focus()
    await act(async () => { finishCopy() })
    expect(document.activeElement).toBe(nextControl)
  })

  test.each(['denied', 'unavailable'] as const)('keeps the answer available when clipboard access is %s', async failure => {
    setClipboard(failure === 'denied' ? { writeText: vi.fn().mockRejectedValue(new Error('denied')) } : undefined)
    render(<AnswerMarkdown copyable>{headingFixture}</AnswerMarkdown>)
    fireEvent.click(screen.getByRole('button', { name: ANSWER_MARKDOWN_COPY.copy }))
    expect(await screen.findByText(ANSWER_MARKDOWN_COPY.failed)).toHaveProperty('role', 'status')
    expect(screen.getByText('Use the east entrance.')).toBeTruthy()
    expect(screen.getByRole('button', { name: ANSWER_MARKDOWN_COPY.copy })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('does not report a pending copy result against a replacement answer', async () => {
    let completeCopy!: () => void
    setClipboard({ writeText: vi.fn(() => new Promise<void>(resolve => { completeCopy = resolve })) })
    const { rerender } = render(<AnswerMarkdown copyable>{headingFixture}</AnswerMarkdown>)
    fireEvent.click(screen.getByRole('button', { name: ANSWER_MARKDOWN_COPY.copy }))
    rerender(<AnswerMarkdown copyable>{'A different saved answer.'}</AnswerMarkdown>)
    await act(async () => { completeCopy() })
    expect(screen.queryByText(ANSWER_MARKDOWN_COPY.copied)).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
    expect(screen.getByRole('button', { name: ANSWER_MARKDOWN_COPY.copy })).toHaveProperty('disabled', false)
  })

  test('resets copy feedback for a changed answer and omits copying for blank answers', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    const { rerender } = render(<AnswerMarkdown copyable>{headingFixture}</AnswerMarkdown>)
    fireEvent.click(screen.getByRole('button', { name: ANSWER_MARKDOWN_COPY.copy }))
    expect(await screen.findByText(ANSWER_MARKDOWN_COPY.copied)).toBeTruthy()
    const replacement = 'Another complete answer.'
    rerender(<AnswerMarkdown copyable>{replacement}</AnswerMarkdown>)
    expect(screen.queryByText(ANSWER_MARKDOWN_COPY.copied)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: ANSWER_MARKDOWN_COPY.copy }))
    expect(await screen.findByText(ANSWER_MARKDOWN_COPY.copied)).toBeTruthy()
    expect(writeText).toHaveBeenLastCalledWith(replacement)
    rerender(<AnswerMarkdown copyable>{'  \n\n'}</AnswerMarkdown>)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
