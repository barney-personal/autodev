// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { DownloadReportButton, REPORT_CLEANUP_DELAY_MS } from '../../client/components/board/DownloadReportButton';
import { SidePanel } from '../../client/components/board/SidePanel';
import { workflowReportFilename } from '@shared/workflowReport';
import { makeWorkflow } from './factories';
import './setup';

type FakeResponse = { ok: boolean; status: number; text: () => Promise<string>; blob: () => Promise<Blob> };

function okResponse(body = '# Report\n'): FakeResponse {
  return { ok: true, status: 200, text: async () => body, blob: async () => new Blob([body], { type: 'text/markdown' }) };
}

function errorResponse(status: number, body: string): FakeResponse {
  return { ok: false, status, text: async () => body, blob: async () => new Blob([body]) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let fetchMock: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let clickSpy: ReturnType<typeof vi.spyOn>;
let clickedAnchors: HTMLAnchorElement[];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  let n = 0;
  createObjectURL = vi.fn(() => `blob:test/${++n}`);
  revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  clickedAnchors = [];
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clickedAnchors.push(this);
  });
});

afterEach(() => {
  clickSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const button = () => screen.getByRole('button', { name: /report/i });

describe('DownloadReportButton', () => {
  it('downloads the report with an ID-bearing filename and no Authorization header', async () => {
    fetchMock.mockResolvedValue(okResponse());
    render(<DownloadReportButton workflowId="wf/odd id" />);
    fireEvent.click(screen.getByRole('button', { name: 'Download report' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Report download started.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/workflows/wf%2Fodd%20id/report');
    expect(init.method).toBe('HEAD');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toBeUndefined();
    expect(JSON.stringify(init)).not.toMatch(/authorization/i);

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clickedAnchors).toHaveLength(1);
    const anchor = clickedAnchors[0];
    expect(anchor.download).toBe(workflowReportFilename('wf/odd id'));
    expect(anchor.download).toBe('autodev-workflow-wf-odd-id-report.md');
    expect(anchor.getAttribute('href')).toBe('/api/workflows/wf%2Fodd%20id/report');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(button()).toBeEnabled();

    // Cleanup is deferred until after the click so the browser can consume the URL.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(document.body.contains(anchor)).toBe(true);
    act(() => { vi.advanceTimersByTime(REPORT_CLEANUP_DELAY_MS); });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(document.body.contains(anchor)).toBe(false);
  });

  it('shows a busy, disabled state and ignores repeated clicks while preparing', async () => {
    const pending = deferred<FakeResponse>();
    fetchMock.mockReturnValue(pending.promise);
    render(<DownloadReportButton workflowId="wf-1" />);
    fireEvent.click(button());
    fireEvent.click(button());

    expect(button()).toHaveTextContent('Preparing report…');
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute('aria-busy', 'true');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve(okResponse()); });
    await waitFor(() => expect(button()).toHaveTextContent('Download report'));
    expect(button()).toBeEnabled();
    expect(button()).toHaveAttribute('aria-busy', 'false');
    expect(clickedAnchors).toHaveLength(1);
  });

  it.each([
    [404, '{"error":"not found"}', 'Report unavailable: this workflow was not found.'],
    [401, '{"error":"unauthorized"}', 'Report unavailable: sign in again to download it.'],
    [500, '{"error":"failed to generate report"}', 'Could not download report (HTTP 500).'],
    [502, '<html><body><script>x()</script>Bad gateway</body></html>', 'Could not download report (HTTP 502).'],
    [503, '', 'Could not download report (HTTP 503).'],
    [500, '{"error":{"nested":true}}', 'Could not download report (HTTP 500).'],
    [500, '{not json', 'Could not download report (HTTP 500).'],
  ])('shows an accessible alert for HTTP %i and re-enables the button', async (status, body, expected) => {
    fetchMock.mockResolvedValue(errorResponse(status, body));
    render(<DownloadReportButton workflowId="wf-1" />);
    fireEvent.click(button());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(expected);
    expect(alert.innerHTML).not.toContain('<');
    expect(button()).toBeEnabled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clickedAnchors).toHaveLength(0);
  });

  it('does not expose response bodies in error messages', async () => {
    fetchMock.mockResolvedValue(errorResponse(500, JSON.stringify({ error: `bad\u0007‮${'x'.repeat(500)}` })));
    render(<DownloadReportButton workflowId="wf-1" />);
    fireEvent.click(button());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/[\u0007‮]/);
    expect(alert.textContent!.length).toBeLessThan(260);
    expect(alert.textContent).toBe('Could not download report (HTTP 500).');
  });

  it('shows an alert on network failure and allows retry', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(okResponse());
    render(<DownloadReportButton workflowId="wf-1" />);
    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
    expect(button()).toBeEnabled();

    fireEvent.click(button());
    expect(await screen.findByRole('status')).toHaveTextContent('Report download started.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses a native attachment without reading or buffering a response body', async () => {
    const readBody = vi.fn().mockRejectedValue(new Error('HEAD has no body'));
    fetchMock.mockResolvedValue({ ...okResponse(), blob: readBody, text: readBody });
    render(<DownloadReportButton workflowId="wf-1" />);
    fireEvent.click(button());
    expect(await screen.findByText('Report download started.')).toBeInTheDocument();
    expect(readBody).not.toHaveBeenCalled();
    expect(clickedAnchors[0].getAttribute('href')).toBe('/api/workflows/wf-1/report');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(button()).toBeEnabled();
  });

  it('still removes the anchor when the click throws', async () => {
    clickSpy.mockImplementation(function (this: HTMLAnchorElement) {
      clickedAnchors.push(this);
      throw new Error('blocked');
    });
    fetchMock.mockResolvedValue(okResponse());
    render(<DownloadReportButton workflowId="wf-1" />);
    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const anchor = clickedAnchors[0];
    act(() => { vi.advanceTimersByTime(REPORT_CLEANUP_DELAY_MS); });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(document.body.contains(anchor)).toBe(false);
  });

  it('aborts and discards a pending request on unmount', async () => {
    const pending = deferred<FakeResponse>();
    fetchMock.mockReturnValue(pending.promise);
    const { unmount } = render(<DownloadReportButton workflowId="wf-1" />);
    fireEvent.click(button());
    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);

    await act(async () => { pending.resolve(okResponse()); });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clickedAnchors).toHaveLength(0);
  });

  it('discards a stale availability check after the workflow changes and lets the new workflow download', async () => {
    const pending = deferred<FakeResponse>();
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(okResponse());
    const { rerender } = render(<DownloadReportButton workflowId="wf-old" />);
    fireEvent.click(button());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const oldSignal: AbortSignal = fetchMock.mock.calls[0][1].signal;

    rerender(<DownloadReportButton workflowId="wf-new" />);
    expect(oldSignal.aborted).toBe(true);
    expect(button()).toHaveTextContent('Download report');
    expect(button()).toBeEnabled();

    await act(async () => { pending.resolve(okResponse()); });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(button());
    expect(await screen.findByText('Report download started.')).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/workflows/wf-new/report');
    expect(clickedAnchors).toHaveLength(1);
    expect(clickedAnchors[0].download).toBe('autodev-workflow-wf-new-report.md');
  });

  it('a stale failure after a workflow change does not clear the new request or show an alert', async () => {
    const oldFetch = deferred<FakeResponse>();
    const newFetch = deferred<FakeResponse>();
    fetchMock.mockReturnValueOnce(oldFetch.promise).mockReturnValueOnce(newFetch.promise);
    const { rerender } = render(<DownloadReportButton workflowId="wf-old" />);
    fireEvent.click(button());
    rerender(<DownloadReportButton workflowId="wf-new" />);
    fireEvent.click(button());
    expect(button()).toBeDisabled();

    await act(async () => { oldFetch.reject(new DOMException('aborted', 'AbortError')); });
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => { newFetch.resolve(okResponse()); });
    await waitFor(() => expect(button()).toBeEnabled());
    expect(clickedAnchors).toHaveLength(1);
  });

  it('clears an old message when the workflow changes', async () => {
    fetchMock.mockResolvedValue(errorResponse(404, ''));
    const { rerender } = render(<DownloadReportButton workflowId="wf-old" />);
    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    rerender(<DownloadReportButton workflowId="wf-new" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('SidePanel report action', () => {
  const sidePanelProps = {
    totalCost: 0, totalDuration: 0, lastActivityTs: Date.now(),
    onResume: vi.fn(), onWrapUp: vi.fn(), onCancel: vi.fn(), acting: false,
  };

  it.each([
    ['running', {}],
    ['blocked', { blocked_reason: 'stuck' }],
    ['complete', { pr_url: 'https://github.com/o/r/pull/1' }],
    ['complete', { pr_url: null }],
    ['cancelled', {}],
    ['failed', { milestones_total: 0, milestones_done: 0, worktree_branch: null, current_phase: 'idle' }],
  ] as const)('renders Download report for a %s workflow', (status, overrides) => {
    const workflow = makeWorkflow({ status: status as never, ...overrides });
    render(<SidePanel workflow={workflow} {...sidePanelProps} />);
    expect(screen.getByRole('button', { name: 'Download report' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Report' })).toBeInTheDocument();
  });

  it('keeps the report action enabled while another workflow action is in flight', () => {
    render(<SidePanel workflow={makeWorkflow({ status: 'blocked' })} {...sidePanelProps} acting />);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download report' })).toBeEnabled();
  });
});
