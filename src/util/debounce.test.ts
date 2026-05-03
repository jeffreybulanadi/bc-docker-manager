import { debounce } from "./debounce";

jest.useFakeTimers();

describe("debounce", () => {
  it("delays execution", () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 100);
    debounced();
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid calls", () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 100);
    debounced();
    debounced();
    debounced();
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel() prevents execution", () => {
    const fn = jest.fn();
    const debounced = debounce(fn, 100);
    debounced();
    debounced.cancel();
    jest.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });
});
