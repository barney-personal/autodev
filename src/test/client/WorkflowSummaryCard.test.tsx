// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { WorkflowSummaryCard } from '../../client/components/WorkflowSummaryCard';
import { makeWorkflow, makeAgent, makeJob } from './factories';
import './setup';

describe('WorkflowSummaryCard', () => {
  it('renders workflow title and cycle progress', () => {
    const workflow = makeWorkflow({ title: 'Refactor auth module', current_cycle: 2, max_cycles: 5 });
    render(<WorkflowSummaryCard workflow={workflow} workflowAgents={[]} now={Date.now()} onClick={vi.fn()} />);
    expect(screen.getByText('Refactor auth module')).toBeInTheDocument();
    expect(screen.getByText('C2/5')).toBeInTheDocument();
  });

  it('shows milestone progress when milestones exist', () => {
    const workflow = makeWorkflow({ milestones_total: 10, milestones_done: 7 });
    render(<WorkflowSummaryCard workflow={workflow} workflowAgents={[]} now={Date.now()} onClick={vi.fn()} />);
    expect(screen.getByText('7/10')).toBeInTheDocument();
  });

  it('shows all four phase pills', () => {
    const workflow = makeWorkflow({ current_phase: 'review', status: 'running' });
    const { container } = render(<WorkflowSummaryCard workflow={workflow} workflowAgents={[]} now={Date.now()} onClick={vi.fn()} />);
    const pills = container.querySelectorAll('.workflow-phase-pill');
    expect(pills).toHaveLength(4);
    expect(pills[0].textContent).toBe('Assess');
    expect(pills[1].textContent).toBe('Review');
    expect(pills[2].textContent).toBe('Implement');
    expect(pills[3].textContent).toBe('Verify');
    expect(pills[1].classList.contains('workflow-phase-current')).toBe(true);
    expect(pills[0].classList.contains('workflow-phase-past')).toBe(true);
  });

  it('shows cost from agents', () => {
    const agents = [
      makeAgent({ cost_usd: 1.50, status: 'done', finished_at: Date.now() }),
      makeAgent({ cost_usd: 0.75, status: 'done', finished_at: Date.now() }),
    ];
    render(<WorkflowSummaryCard workflow={makeWorkflow()} workflowAgents={agents} now={Date.now()} onClick={vi.fn()} />);
    expect(screen.getByText(/\$2\.25/)).toBeInTheDocument();
  });

  it('shows elapsed time for running workflows', () => {
    const now = Date.now();
    const workflow = makeWorkflow({ status: 'running', created_at: now - 3_720_000 });
    render(<WorkflowSummaryCard workflow={workflow} workflowAgents={[]} now={now} onClick={vi.fn()} />);
    expect(screen.getByText(/1h 2m/)).toBeInTheDocument();
  });

  it('shows job count', () => {
    const agents = [makeAgent(), makeAgent(), makeAgent()];
    render(<WorkflowSummaryCard workflow={makeWorkflow()} workflowAgents={agents} now={Date.now()} onClick={vi.fn()} />);
    expect(screen.getByText('Jobs: 3')).toBeInTheDocument();
  });

  it('calls onClick when card is clicked', () => {
    const onClick = vi.fn();
    const { container } = render(<WorkflowSummaryCard workflow={makeWorkflow()} workflowAgents={[]} now={Date.now()} onClick={onClick} />);
    fireEvent.click(container.querySelector('.workflow-summary-card')!);
    expect(onClick).toHaveBeenCalled();
  });

  it('shows ETA when running with cycle history', () => {
    const now = Date.now();
    const workflow = makeWorkflow({ status: 'running', current_cycle: 2, max_cycles: 5, created_at: now - 600_000 });
    const { container } = render(<WorkflowSummaryCard workflow={workflow} workflowAgents={[]} now={now} onClick={vi.fn()} />);
    expect(container.querySelector('.workflow-summary-stats')?.textContent).toContain('ETA');
  });

  it('does not show ETA when workflow is complete', () => {
    const now = Date.now();
    const workflow = makeWorkflow({ status: 'complete', current_cycle: 3, max_cycles: 3, created_at: now - 600_000, updated_at: now });
    const { container } = render(<WorkflowSummaryCard workflow={workflow} workflowAgents={[]} now={now} onClick={vi.fn()} />);
    expect(container.querySelector('.workflow-summary-stats')?.textContent).not.toContain('ETA');
  });

  it('uses approximate cost indicator when no final cost is available', () => {
    const agents = [makeAgent({
      cost_usd: null, estimated_input_tokens: 100_000, estimated_output_tokens: 5_000,
      job: makeJob({ model: 'claude-sonnet-4-6' }),
    })];
    render(<WorkflowSummaryCard workflow={makeWorkflow()} workflowAgents={agents} now={Date.now()} onClick={vi.fn()} />);
    expect(screen.getByText(/~\$/)).toBeInTheDocument();
  });
});
