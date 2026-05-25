// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { TaskForm } from '../../client/components/TaskForm';
import type { CreateTaskRequest } from '@shared/types';
import './setup';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/api/templates') || url.includes('/api/models')) {
      return Promise.resolve(new Response(JSON.stringify(
        url.includes('templates')
          ? []
          : { claude: [], codex: [], lastFetchedAt: null },
      )));
    }
    return Promise.resolve(new Response('ok'));
  }));
});

async function submit(onSubmit: ReturnType<typeof vi.fn>) {
  const description = screen.getByLabelText(/task description/i);
  fireEvent.change(description, { target: { value: 'do the thing' } });
  const button = screen.getByRole('button', { name: /create job|start autonomous run/i });
  await act(async () => {
    fireEvent.click(button);
  });
  return onSubmit.mock.calls[0]?.[0] as CreateTaskRequest | undefined;
}

describe('TaskForm preset routing', () => {
  it('Quick preset submits an iterations=1 job request', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TaskForm onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Quick' }));
    const req = await submit(onSubmit);
    expect(req).toBeDefined();
    expect(req!.preset).toBe('quick');
    expect(req!.iterations).toBe(1);
    expect(req!.review).toBe(false);
    expect(req!.useWorktree).toBeUndefined();
  });

  it('Reviewed preset submits an iterations=1 reviewed job request', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TaskForm onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    const req = await submit(onSubmit);
    expect(req).toBeDefined();
    expect(req!.preset).toBe('reviewed');
    expect(req!.iterations).toBe(1);
    expect(req!.review).toBe(true);
    expect(req!.useWorktree).toBe(true);
  });

  it('Autonomous preset submits a workflow-routed task with iterations>1', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TaskForm onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Autonomous' }));
    const req = await submit(onSubmit);
    expect(req).toBeDefined();
    expect(req!.preset).toBe('autonomous');
    expect(req!.iterations).toBeGreaterThan(1);
    expect(req!.review).toBe(true);
    expect(req!.useWorktree).toBe(true);
    // workflow route must not carry job-only fields
    expect(req!.stopMode).toBeUndefined();
    expect(req!.retryPolicy).toBeUndefined();
  });
});
