// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Header } from '../../client/components/Header';
import './setup';

function makeHeaderProps(overrides: Record<string, unknown> = {}) {
  return {
    onNewTask: vi.fn(), onTemplates: vi.fn(), onBatchTemplates: vi.fn(), onUsage: vi.fn(),
    onSearch: vi.fn(), onTimeline: vi.fn(), onDag: vi.fn(), onProjects: vi.fn(),
    onSettings: vi.fn(), onDebate: vi.fn(), onKnowledgeBase: vi.fn(), onEye: vi.fn(),
    onHome: vi.fn(), ...overrides,
  };
}

describe('Header', () => {
  it('renders the application title', () => {
    render(<Header {...makeHeaderProps()} />);
    expect(screen.getByText('Autodev')).toBeInTheDocument();
  });

  it('calls onNewTask when New Task button is clicked', () => {
    const props = makeHeaderProps();
    render(<Header {...props} />);
    fireEvent.click(screen.getByText('+ New Task'));
    expect(props.onNewTask).toHaveBeenCalled();
  });

  it('calls onHome when logo is clicked', () => {
    const props = makeHeaderProps();
    render(<Header {...props} />);
    fireEvent.click(screen.getByLabelText('Go to main dashboard'));
    expect(props.onHome).toHaveBeenCalled();
  });

  it('shows project badge when currentProjectName is set', () => {
    render(<Header {...makeHeaderProps({ currentProjectName: 'My Project' })} />);
    expect(screen.getByText('My Project')).toBeInTheDocument();
  });

  it('calls onClearProject when project badge X is clicked', () => {
    const onClearProject = vi.fn();
    render(<Header {...makeHeaderProps({ currentProjectName: 'Active Project', onClearProject })} />);
    fireEvent.click(screen.getByLabelText('Clear project filter: Active Project'));
    expect(onClearProject).toHaveBeenCalled();
  });

  it('shows cost display when todayClaudeCost is provided', () => {
    render(<Header {...makeHeaderProps({ todayClaudeCost: 12.5678 })} />);
    expect(screen.getByText(/Claude \$12\.5678/)).toBeInTheDocument();
  });

  it('focuses search input and triggers onSearch', () => {
    const props = makeHeaderProps();
    render(<Header {...props} />);
    fireEvent.focus(screen.getByPlaceholderText(/Search/));
    expect(props.onSearch).toHaveBeenCalled();
  });

  it('shows Eye button with badge when eyeEnabled and eyeBadgeCount > 0', () => {
    render(<Header {...makeHeaderProps({ eyeEnabled: true, eyeBadgeCount: 3 })} />);
    expect(screen.getByText('Eye')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('does not show Eye button when eyeEnabled is falsy', () => {
    render(<Header {...makeHeaderProps({ eyeEnabled: false })} />);
    expect(screen.queryAllByText('Eye')).toHaveLength(0);
  });
});
